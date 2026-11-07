import { awsProfiles, pooled, readAwsProfile } from "./aws_reader.ts";
import { networkFetch, readDigitalOceanAddresses } from "./digitalocean_reader.ts";
import {
  CLOUD_NAMES,
  type AddressObservation,
  type CloudAccount,
  type CloudAddressesInput,
  type CloudAddressesInventory,
  type CloudFetch,
  type CloudName,
  type CloudRunner,
  type SourceRead,
} from "./types.ts";

/** Profiles read at once: each one fans out to four regions of four processes. */
const PROFILE_CONCURRENCY = 3;

/** What the readers touch outside this module; production binds them to `pi.exec`, the environment and the network. */
export interface ReaderDeps {
  readonly runner: CloudRunner;
  /** The text of the AWS config file the CLI would use, or undefined when it cannot be read. */
  readonly readAwsConfig: () => Promise<string | undefined>;
  readonly digitalOceanToken: string | undefined;
  readonly fetch?: CloudFetch;
  readonly signal?: AbortSignal;
}

type Read = { readonly source: SourceRead; readonly held: readonly AddressObservation[] };

/** A source that ran no read at all: the reason is the whole answer for that cloud. */
const notRead = (name: CloudName, reason: string): SourceRead => ({ name, status: "not_read", reason, accounts: [] });

async function readAws(input: CloudAddressesInput, deps: ReaderDeps): Promise<Read> {
  const profiles =
    input.profiles !== undefined && input.profiles.length > 0 ? input.profiles : awsProfiles(await deps.readAwsConfig());
  if (profiles.length === 0) {
    return { source: notRead("aws", "no AWS profile: the AWS config names none, and none was asked for"), held: [] };
  }
  const reads = await pooled(profiles, PROFILE_CONCURRENCY, (profile) =>
    readAwsProfile(deps.runner, profile, input.regions));
  const accounts: CloudAccount[] = reads.map((read) => ({
    cloud: "aws",
    name: read.profile,
    ...(read.account === undefined ? {} : { account: read.account }),
    ...(read.unread === undefined ? {} : { unread: read.unread }),
    regions: [...read.regions],
  }));
  const anyRead = reads.some((read) => read.unread === undefined);
  return {
    source: {
      name: "aws",
      status: anyRead ? "read" : "not_read",
      ...(anyRead ? {} : { reason: "no AWS profile could be read" }),
      accounts,
    },
    held: reads.flatMap((read) => read.observations),
  };
}

async function readDigitalOcean(deps: ReaderDeps): Promise<Read> {
  const read = await readDigitalOceanAddresses(deps.fetch ?? networkFetch, deps.digitalOceanToken, deps.signal);
  const account: CloudAccount = {
    cloud: "digitalocean",
    name: read.name,
    ...(read.account === undefined ? {} : { account: read.account }),
    ...(read.unread === undefined ? {} : { unread: read.unread }),
    regions: [],
  };
  if (read.unread !== undefined && read.observations.length === 0 && read.account === undefined) {
    return { source: notRead("digitalocean", read.unread), held: [] };
  }
  return { source: { name: "digitalocean", status: "read", accounts: [account] }, held: read.observations };
}

/** Reads every cloud in scope (all of them unless `sources` narrows it) and reports each one's coverage. */
export async function readCloudAddresses(
  input: CloudAddressesInput,
  deps: ReaderDeps,
): Promise<CloudAddressesInventory> {
  const scope = new Set<CloudName>(input.sources ?? CLOUD_NAMES);
  const reads = await Promise.all([
    scope.has("aws") ? readAws(input, deps) : undefined,
    scope.has("digitalocean") ? readDigitalOcean(deps) : undefined,
  ]);
  const done = reads.filter((read): read is Read => read !== undefined);
  return { held: done.flatMap((read) => [...read.held]), sources: done.map((read) => read.source) };
}
