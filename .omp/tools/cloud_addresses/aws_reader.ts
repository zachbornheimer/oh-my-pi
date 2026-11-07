import type { AddressObservation, CloudRunner, RegionRead } from "./types.ts";

/**
 * What the owner's AWS accounts hold, read through the AWS CLI. Every call is a read: the CLI is asked only for the
 * account's identity, its regions, its Elastic IPs, its running instances, and its Lightsail static IPs and instances,
 * and nothing is ever written. A call that fails is recorded as coverage, never thrown: a region nobody could read is
 * not a region with no addresses.
 */

export const AWS_COMMAND = "aws";
/** Regions read at once. Each region's read starts four processes, so this is the cap on the CLI's own fan-out. */
export const REGION_CONCURRENCY = 4;

/** The profiles an AWS config file names: `[default]` and every `[profile <name>]`, in file order, each once. */
export function awsProfiles(configText: string | undefined): string[] {
  const names: string[] = [];
  for (const line of (configText ?? "").split("\n")) {
    const section = /^\s*\[(.+?)]\s*$/.exec(line)?.[1];
    if (section === undefined) continue;
    const name = section === "default" ? "default" : /^profile\s+(.+)$/.exec(section)?.[1]?.trim();
    if (name !== undefined && name !== "" && !names.includes(name)) names.push(name);
  }
  return names;
}

/** A profile name is passed to `--profile <name>`: it must not read as another option. */
export const SAFE_PROFILE = /^[A-Za-z0-9][A-Za-z0-9._@+=:/ -]*$/;
/** A region name such as `us-east-1`, `us-gov-west-1`, `cn-north-1`. */
export function isSafeRegion(region: string): boolean {
  const parts = region.split("-");
  return parts.length >= 2 && parts.every((part) => /^[a-z0-9]+$/.test(part));
}

/**
 * Maps with at most `limit` calls in flight. An account lists every region, and each region's read starts four
 * processes, so an unbounded map would start one process per region at once.
 */
export async function pooled<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** A region's failure that means "this service is not offered here", which is not a coverage gap. */
const NOT_APPLICABLE =
  /could not connect to the endpoint|unsupportedregion|invalidaction|not available in this region|not supported in this region|is not supported/i;

/** What one account's reads answered. `unread` is set when the account itself could not be read. */
export interface AwsProfileRead {
  readonly profile: string;
  readonly account?: string;
  readonly regions: readonly RegionRead[];
  readonly observations: readonly AddressObservation[];
  readonly unread?: string;
}

type Called = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string };

/** The first line of the tool's own complaint, so a coverage reason stays one line. */
const firstLine = (text: string): string => text.trim().split("\n")[0]?.trim() ?? "";

async function awsJson(runner: CloudRunner, profile: string, args: readonly string[]): Promise<Called> {
  const result = await runner.run(AWS_COMMAND, [...args, "--profile", profile, "--no-cli-pager", "--output", "json"]);
  if (result.code !== 0) {
    return { ok: false, reason: firstLine(result.stderr) || `aws exited ${result.code}` };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout) as unknown };
  } catch {
    return { ok: false, reason: "aws did not answer with JSON" };
  }
}

/** The `key` array of records inside a JSON answer, or none. */
function recordsOf(value: unknown, key: string): readonly Record<string, unknown>[] {
  const found = (value as Record<string, unknown> | null)?.[key];
  if (!Array.isArray(found)) return [];
  return found.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null);
}

const textOf = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** The instance's `Name` tag, which is what a person calls the machine. */
function nameOf(tags: unknown): string | undefined {
  if (!Array.isArray(tags)) return undefined;
  const named = tags.find(
    (tag): tag is Record<string, unknown> =>
      typeof tag === "object" && tag !== null && (tag as Record<string, unknown>).Key === "Name",
  );
  return textOf(named?.Value);
}

/** One Elastic IP row; an address with no association is one we still hold and pay for. */
function elasticIps(value: unknown, profile: string, account: string, region: string): AddressObservation[] {
  return recordsOf(value, "Addresses").flatMap((entry) => {
    const address = textOf(entry.PublicIp);
    if (address === undefined) return [];
    const allocation = textOf(entry.AllocationId);
    return [{
      address,
      cloud: "aws" as const,
      kind: "elastic_ip" as const,
      profile,
      account,
      region,
      ...(allocation === undefined ? {} : { resource_id: allocation }),
      state: textOf(entry.AssociationId) === undefined ? "unassociated" : "associated",
    }];
  });
}

/** One row per running instance address (IPv4 and IPv6); a stopped instance holds none. */
function instances(value: unknown, profile: string, account: string, region: string): AddressObservation[] {
  const rows = recordsOf(value, "Reservations").flatMap((reservation) => recordsOf(reservation, "Instances"));
  return rows.flatMap((entry) => {
    const resourceId = textOf(entry.InstanceId);
    const state = textOf((entry.State as Record<string, unknown> | undefined)?.Name) ?? "running";
    const resourceName = nameOf(entry.Tags);
    const addresses = [textOf(entry.PublicIpAddress), textOf(entry.Ipv6Address)].filter(
      (address): address is string => address !== undefined,
    );
    return addresses.map((address) => ({
      address,
      cloud: "aws" as const,
      kind: "instance_public_address" as const,
      profile,
      account,
      region,
      ...(resourceId === undefined ? {} : { resource_id: resourceId }),
      ...(resourceName === undefined ? {} : { resource_name: resourceName }),
      state,
    }));
  });
}

function lightsailStaticIps(value: unknown, profile: string, account: string, region: string): AddressObservation[] {
  return recordsOf(value, "staticIps").flatMap((entry) => {
    const address = textOf(entry.ipAddress);
    if (address === undefined) return [];
    const name = textOf(entry.name);
    return [{
      address,
      cloud: "aws" as const,
      kind: "lightsail_static_ip" as const,
      profile,
      account,
      region,
      ...(name === undefined ? {} : { resource_id: name, resource_name: name }),
      state: entry.isAttached === true ? "attached" : "detached",
    }];
  });
}

function lightsailInstances(value: unknown, profile: string, account: string, region: string): AddressObservation[] {
  return recordsOf(value, "instances").flatMap((entry) => {
    const address = textOf(entry.publicIpAddress);
    if (address === undefined) return [];
    const name = textOf(entry.name);
    return [{
      address,
      cloud: "aws" as const,
      kind: "lightsail_instance" as const,
      profile,
      account,
      region,
      ...(name === undefined ? {} : { resource_id: name, resource_name: name }),
      state: textOf((entry.state as Record<string, unknown> | undefined)?.name) ?? "unknown",
    }];
  });
}

/** The regions the account lists, skipping the ones it has not opted into. */
async function accountRegions(
  runner: CloudRunner,
  profile: string,
  asked?: readonly string[],
): Promise<{ readonly ok: true; readonly value: readonly string[] } | { readonly ok: false; readonly reason: string }> {
  if (asked !== undefined && asked.length > 0) return { ok: true, value: asked };
  const called = await awsJson(runner, profile, ["ec2", "describe-regions"]);
  if (!called.ok) return called;
  const regions = recordsOf(called.value, "Regions").flatMap((entry) => {
    if (entry.OptInStatus === "not-opted-in") return [];
    const name = textOf(entry.RegionName);
    return name === undefined ? [] : [name];
  });
  return { ok: true, value: regions };
}

/** One region's four reads: EC2's addresses and instances, then Lightsail's static IPs and instances. */
async function readRegion(
  runner: CloudRunner,
  profile: string,
  account: string,
  region: string,
): Promise<{ readonly read: RegionRead; readonly observations: AddressObservation[] }> {
  const regionArgs = (service: readonly string[]) => [...service, "--region", region];
  const calls = [
    { name: "elastic_ips", called: awsJson(runner, profile, regionArgs(["ec2", "describe-addresses"])) },
    {
      name: "instances",
      called: awsJson(runner, profile, regionArgs([
        "ec2",
        "describe-instances",
        "--filters",
        "Name=instance-state-name,Values=running",
      ])),
    },
    { name: "lightsail_static_ips", called: awsJson(runner, profile, regionArgs(["lightsail", "get-static-ips"])) },
    { name: "lightsail_instances", called: awsJson(runner, profile, regionArgs(["lightsail", "get-instances"])) },
  ] as const;
  const answered = await Promise.all(calls.map(async (call) => ({ name: call.name, result: await call.called })));
  const observations: AddressObservation[] = [];
  const failures: { readonly name: string; readonly reason: string; readonly notApplicable: boolean }[] = [];
  for (const { name, result } of answered) {
    if (!result.ok) {
      failures.push({ name, reason: result.reason, notApplicable: NOT_APPLICABLE.test(result.reason) });
      continue;
    }
    if (name === "elastic_ips") observations.push(...elasticIps(result.value, profile, account, region));
    else if (name === "instances") observations.push(...instances(result.value, profile, account, region));
    else if (name === "lightsail_static_ips") {
      observations.push(...lightsailStaticIps(result.value, profile, account, region));
    } else observations.push(...lightsailInstances(result.value, profile, account, region));
  }
  if (failures.length === 0) return { read: { region, status: "read" }, observations };
  const first = failures[0]!;
  const everyFailureIsMissing = failures.every((failure) => failure.notApplicable);
  return {
    read: {
      region,
      status: everyFailureIsMissing ? "not_applicable" : "not_read",
      reason: `${first.name}: ${first.reason}`,
    },
    observations,
  };
}

/**
 * One profile's addresses: its account id, then each region's reads. A profile whose identity cannot be read is
 * `unread`, and the reason is the CLI's own complaint, so a profile with no credentials never looks like an account
 * holding nothing.
 */
export async function readAwsProfile(
  runner: CloudRunner,
  profile: string,
  regions?: readonly string[],
): Promise<AwsProfileRead> {
  if (!SAFE_PROFILE.test(profile)) {
    return { profile, regions: [], observations: [], unread: `not a usable AWS profile name: ${JSON.stringify(profile)}` };
  }
  const badRegion = regions?.find((region) => !isSafeRegion(region));
  if (badRegion !== undefined) {
    return { profile, regions: [], observations: [], unread: `not a usable AWS region name: ${JSON.stringify(badRegion)}` };
  }
  const identity = await awsJson(runner, profile, ["sts", "get-caller-identity"]);
  if (!identity.ok) return { profile, regions: [], observations: [], unread: identity.reason };
  const account = textOf((identity.value as Record<string, unknown> | null)?.Account);
  if (account === undefined) return { profile, regions: [], observations: [], unread: "no account id in the identity" };
  const listed = await accountRegions(runner, profile, regions);
  if (!listed.ok) return { profile, account, regions: [], observations: [], unread: `regions: ${listed.reason}` };
  const reads = await pooled(listed.value, REGION_CONCURRENCY, (region) => readRegion(runner, profile, account, region));
  return {
    profile,
    account,
    regions: reads.map((read) => read.read),
    observations: reads.flatMap((read) => read.observations),
  };
}
