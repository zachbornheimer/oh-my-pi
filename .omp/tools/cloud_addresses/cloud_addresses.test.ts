/**
 * `cloud_addresses` against fakes: the merge and sort, the AWS and DigitalOcean readers, the coverage rows, and the tool's
 * execute. Ported from the Mastra capability's tests. Nothing here runs `aws`, reads a real config or reaches the network.
 */
import { describe, expect, it } from "bun:test";
import { awsProfiles, isSafeRegion, pooled, readAwsProfile } from "./aws_reader.ts";
import { DIGITALOCEAN_API_VARIABLE, readDigitalOceanAddresses } from "./digitalocean_reader.ts";
import { DESCRIPTION, buildTool, coverageLine } from "./index.ts";
import { heldAddresses } from "./merge.ts";
import { readCloudAddresses } from "./readers.ts";
import type { AddressObservation, CloudFetch, CloudRunner, ProcessResult } from "./types.ts";

const json = (body: unknown): ProcessResult => ({ code: 0, stdout: JSON.stringify(body), stderr: "" });
const failed = (stderr: string): ProcessResult => ({ code: 255, stdout: "", stderr });

interface FakeAws {
  readonly runner: CloudRunner;
  /** Every call, as `<service> <action> [<region>]`, so a test can see what was read and what was skipped. */
  readonly calls: string[];
  /** Every full argument list, to prove no call writes. */
  readonly argv: (readonly string[])[];
}

/** A runner answering from `answer(service, region, profile)`, recording every call it was asked for. */
function fakeAws(answer: (service: string, region: string | undefined, profile: string) => ProcessResult): FakeAws {
  const calls: string[] = [];
  const argv: (readonly string[])[] = [];
  return {
    calls,
    argv,
    runner: {
      run: async (command, args) => {
        expect(command).toBe("aws");
        argv.push(args);
        const service = `${args[0] ?? ""} ${args[1] ?? ""}`.trim();
        const at = args.indexOf("--region");
        const region = at === -1 ? undefined : args[at + 1];
        const profile = args[args.indexOf("--profile") + 1]!;
        calls.push(region === undefined ? service : `${service} ${region}`);
        return answer(service, region, profile);
      },
    },
  };
}

const ACCOUNT = "514598028285";

/** The answers a healthy account gives: one region, two Elastic IPs, one instance, one Lightsail pair. */
const healthy = (service: string): ProcessResult => {
  if (service === "sts get-caller-identity") return json({ Account: ACCOUNT });
  if (service === "ec2 describe-regions") {
    return json({ Regions: [{ RegionName: "us-east-1", OptInStatus: "opt-in-not-required" }] });
  }
  if (service === "ec2 describe-addresses") {
    return json({
      Addresses: [
        { PublicIp: "34.199.92.113", AllocationId: "eipalloc-1", AssociationId: "eipassoc-1", InstanceId: "i-1" },
        { PublicIp: "54.198.191.19", AllocationId: "eipalloc-2" },
      ],
    });
  }
  if (service === "ec2 describe-instances") {
    return json({
      Reservations: [{
        Instances: [{
          InstanceId: "i-1",
          PublicIpAddress: "34.199.92.113",
          Ipv6Address: "2600:1f18::1",
          State: { Name: "running" },
          Tags: [{ Key: "Name", Value: "srv1" }],
        }],
      }],
    });
  }
  if (service === "lightsail get-static-ips") {
    return json({ staticIps: [{ name: "static-1", ipAddress: "3.1.2.3", isAttached: true }] });
  }
  if (service === "lightsail get-instances") {
    return json({ instances: [{ name: "ls1", publicIpAddress: "5.6.7.8", state: { name: "running" } }] });
  }
  return failed(`not stubbed: ${service}`);
};

const observation = (address: string, holder: Partial<AddressObservation> = {}): AddressObservation => ({
  address,
  cloud: "aws",
  kind: "elastic_ip",
  profile: "sah",
  account: ACCOUNT,
  ...holder,
});

describe("heldAddresses", () => {
  it("gives one entry per address, with every resource that holds it", () => {
    const addresses = heldAddresses([
      observation("34.199.92.113", { region: "us-east-1", resource_id: "eipalloc-1", state: "associated" }),
      observation("34.199.92.113", {
        kind: "instance_public_address",
        region: "us-east-1",
        resource_id: "i-1",
        resource_name: "srv1",
        state: "running",
      }),
    ]);
    expect(addresses).toHaveLength(1);
    expect(addresses[0]?.holders.map((holder) => [holder.kind, holder.resource_id])).toEqual([
      ["elastic_ip", "eipalloc-1"],
      ["instance_public_address", "i-1"],
    ]);
  });

  it("counts one resource once when two reads report it", () => {
    const row = observation("3.237.32.45", { kind: "lightsail_static_ip", resource_id: "static-1" });
    const addresses = heldAddresses([row, { ...row }]);
    expect(addresses).toHaveLength(1);
    expect(addresses[0]?.holders).toHaveLength(1);
  });

  it("sorts addresses in address order, not text order", () => {
    const addresses = heldAddresses([
      observation("34.199.92.113"),
      observation("3.237.32.45"),
      observation("50.16.105.10"),
    ]);
    expect(addresses.map((entry) => entry.address)).toEqual(["3.237.32.45", "34.199.92.113", "50.16.105.10"]);
  });

  it("puts IPv4 first and IPv6 after, in the same order whatever order the reads came in", () => {
    // The source compared a number with a string for a mixed list, which is not a total order: the result depended on the input order.
    const rows = ["2600:1f18::1", "34.199.92.113", "2001:db8::1", "3.1.2.3", "2600:1f18::0"];
    const expected = ["3.1.2.3", "34.199.92.113", "2001:db8::1", "2600:1f18::0", "2600:1f18::1"];
    for (const order of [rows, [...rows].reverse(), [rows[2]!, rows[0]!, rows[4]!, rows[3]!, rows[1]!]]) {
      expect(heldAddresses(order.map((address) => observation(address))).map((entry) => entry.address)).toEqual(expected);
    }
  });

  it("is empty for no observations", () => {
    expect(heldAddresses([])).toEqual([]);
  });
});

describe("awsProfiles", () => {
  it("reads the default profile and every named one, ignoring other sections", () => {
    const config = [
      "[default]",
      "region = us-east-1",
      "",
      "[profile sah]",
      "region = us-east-1",
      "",
      "[sso-session corp]",
      "sso_start_url = https://example.awsapps.com/start",
      "",
      "[profile sah]",
      "region = us-west-2",
    ].join("\n");
    expect(awsProfiles(config)).toEqual(["default", "sah"]);
  });

  it("names nothing when the config is missing", () => {
    expect(awsProfiles(undefined)).toEqual([]);
  });
});

describe("readAwsProfile", () => {
  it("reports every Elastic IP, the running instances' addresses and the Lightsail addresses", async () => {
    const { runner } = fakeAws(healthy);
    const read = await readAwsProfile(runner, "sah");
    expect(read.account).toBe(ACCOUNT);
    expect(read.unread).toBeUndefined();
    expect(read.regions).toEqual([{ region: "us-east-1", status: "read" }]);
    expect(read.observations.map((entry) => [entry.address, entry.kind, entry.state])).toEqual([
      ["34.199.92.113", "elastic_ip", "associated"],
      ["54.198.191.19", "elastic_ip", "unassociated"],
      ["34.199.92.113", "instance_public_address", "running"],
      ["2600:1f18::1", "instance_public_address", "running"],
      ["3.1.2.3", "lightsail_static_ip", "attached"],
      ["5.6.7.8", "lightsail_instance", "running"],
    ]);
    expect(read.observations[2]).toMatchObject({ resource_id: "i-1", resource_name: "srv1", profile: "sah" });
    expect(read.observations[0]).toMatchObject({ account: ACCOUNT, region: "us-east-1", cloud: "aws" });
  });

  it("only ever asks the AWS CLI to describe, list or get", async () => {
    const { runner, argv } = fakeAws(healthy);
    await readAwsProfile(runner, "sah");
    expect(argv.length).toBeGreaterThan(5);
    for (const args of argv) {
      expect(args[1]).toMatch(/^(get-caller-identity|describe-regions|describe-addresses|describe-instances|get-static-ips|get-instances)$/);
      expect(args).toContain("--no-cli-pager");
    }
  });

  it("keeps a region's EC2 rows and calls the region covered when the only failure is a service it does not offer", async () => {
    const { runner } = fakeAws((service) =>
      service.startsWith("lightsail")
        ? failed('Could not connect to the endpoint URL: "https://lightsail.eu-west-3.amazonaws.com/"')
        : healthy(service));
    const read = await readAwsProfile(runner, "sah");
    expect(read.regions).toEqual([{
      region: "us-east-1",
      status: "not_applicable",
      reason: 'lightsail_static_ips: Could not connect to the endpoint URL: "https://lightsail.eu-west-3.amazonaws.com/"',
    }]);
    expect(read.observations.map((entry) => entry.address)).toEqual(["34.199.92.113", "54.198.191.19", "34.199.92.113", "2600:1f18::1"]);
  });

  it("calls a region not_read on any other failure, and still reports what the other reads found", async () => {
    const { runner } = fakeAws((service) =>
      service === "ec2 describe-addresses"
        ? failed("An error occurred (AuthFailure) when calling the DescribeAddresses operation")
        : healthy(service));
    const read = await readAwsProfile(runner, "sah");
    expect(read.regions[0]).toMatchObject({
      region: "us-east-1",
      status: "not_read",
      reason: "elastic_ips: An error occurred (AuthFailure) when calling the DescribeAddresses operation",
    });
    expect(read.observations.map((entry) => entry.kind)).toEqual([
      "instance_public_address",
      "instance_public_address",
      "lightsail_static_ip",
      "lightsail_instance",
    ]);
  });

  it("calls a region not_read when the CLI answers with something that is not JSON", async () => {
    const { runner } = fakeAws((service) =>
      service === "lightsail get-instances" ? { code: 0, stdout: "<html>", stderr: "" } : healthy(service));
    const read = await readAwsProfile(runner, "sah");
    expect(read.regions[0]).toMatchObject({ status: "not_read", reason: "lightsail_instances: aws did not answer with JSON" });
  });

  it("names the exit code when the CLI fails with no message (a timed-out call is exit -1)", async () => {
    const { runner } = fakeAws((service) =>
      service === "ec2 describe-instances" ? { code: -1, stdout: "", stderr: "" } : healthy(service));
    const read = await readAwsProfile(runner, "sah");
    expect(read.regions[0]).toMatchObject({ status: "not_read", reason: "instances: aws exited -1" });
  });

  it("reports a profile whose identity cannot be read as unread, and reads no region", async () => {
    const { runner, calls } = fakeAws((service) =>
      service === "sts get-caller-identity" ? failed("Unable to locate credentials") : healthy(service));
    const read = await readAwsProfile(runner, "eapp-local-dev");
    expect(read).toEqual({
      profile: "eapp-local-dev",
      regions: [],
      observations: [],
      unread: "Unable to locate credentials",
    });
    expect(calls).toEqual(["sts get-caller-identity"]);
  });

  it("reports an identity with no account id as unread", async () => {
    const { runner } = fakeAws((service) => (service === "sts get-caller-identity" ? json({}) : healthy(service)));
    expect((await readAwsProfile(runner, "sah")).unread).toBe("no account id in the identity");
  });

  it("reports the regions listing's failure as the account being unread, naming the account", async () => {
    const { runner } = fakeAws((service) =>
      service === "ec2 describe-regions" ? failed("UnauthorizedOperation") : healthy(service));
    const read = await readAwsProfile(runner, "sah");
    expect(read).toMatchObject({ profile: "sah", account: ACCOUNT, unread: "regions: UnauthorizedOperation", regions: [] });
  });

  it("reads only the regions it was asked for, and lists none itself", async () => {
    const { runner, calls } = fakeAws(healthy);
    const read = await readAwsProfile(runner, "sah", ["us-west-2"]);
    expect(read.regions).toEqual([{ region: "us-west-2", status: "read" }]);
    expect(calls).not.toContain("ec2 describe-regions");
    expect(calls).toContain("ec2 describe-addresses us-west-2");
  });

  it("skips a region the account has not opted into", async () => {
    const { runner, calls } = fakeAws((service) =>
      service === "ec2 describe-regions"
        ? json({ Regions: [
          { RegionName: "us-east-1", OptInStatus: "opt-in-not-required" },
          { RegionName: "ap-east-1", OptInStatus: "not-opted-in" },
        ] })
        : healthy(service));
    const read = await readAwsProfile(runner, "sah");
    expect(read.regions.map((entry) => entry.region)).toEqual(["us-east-1"]);
    expect(calls).not.toContain("ec2 describe-addresses ap-east-1");
  });

  it("never passes a profile or region that could read as a CLI option", async () => {
    const { runner, calls } = fakeAws(healthy);
    const profile = await readAwsProfile(runner, "--endpoint-url=http://evil");
    expect(profile.unread).toContain("not a usable AWS profile name");
    const region = await readAwsProfile(runner, "sah", ["--debug"]);
    expect(region.unread).toContain("not a usable AWS region name");
    expect(calls).toEqual([]);
  });
});

describe("pooled", () => {
  it("runs at most the limit at once and keeps the order", async () => {
    const release = Promise.withResolvers<void>();
    const firstWave = Promise.withResolvers<void>();
    let inFlight = 0;
    let peak = 0;
    const running = pooled([1, 2, 3, 4, 5], 2, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      if (inFlight === 2) firstWave.resolve();
      await release.promise;
      inFlight -= 1;
      return item * 2;
    });
    await firstWave.promise;
    expect(peak).toBe(2);
    release.resolve();
    expect(await running).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(2);
  });
});

interface Answer {
  readonly status?: number;
  readonly body?: unknown;
  readonly text?: string;
}

/** A fetch answering from `answer(url)`, recording every url and the token it carried. */
function fakeFetch(answer: (url: string) => Answer): { fetch: CloudFetch; calls: { url: string; authorization: string }[] } {
  const calls: { url: string; authorization: string }[] = [];
  const fetch: CloudFetch = async (url, init) => {
    calls.push({ url, authorization: init.headers.authorization ?? "" });
    const { status = 200, body, text } = answer(url);
    return text === undefined
      ? new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
      : new Response(text, { status });
  };
  return { fetch, calls };
}

const DO_ACCOUNT = { account: { email: "zach@example.com", team: { name: "Zysys" } } };
const RESERVED = {
  reserved_ips: [
    { ip: "159.65.47.218", droplet: { id: 1, name: "ds" }, region: { slug: "nyc3" } },
    { ip: "104.236.33.38", droplet: null, region: { slug: "nyc3" } },
  ],
};
const DROPLETS = {
  droplets: [{
    id: 2,
    name: "billing",
    status: "active",
    region: { slug: "nyc1" },
    networks: { v4: [{ ip_address: "104.236.97.50", type: "public" }, { ip_address: "10.0.0.5", type: "private" }] },
  }],
};

const doHealthy = (url: string): Answer => {
  if (url.endsWith("/account")) return { body: DO_ACCOUNT };
  if (url.includes("/reserved_ips")) return { body: RESERVED };
  if (url.includes("/droplets")) return { body: DROPLETS };
  return { status: 404, text: "not stubbed" };
};

describe("readDigitalOceanAddresses", () => {
  it("reads nothing, and says why, without the token", async () => {
    const { fetch, calls } = fakeFetch(doHealthy);
    const read = await readDigitalOceanAddresses(fetch, undefined);
    expect(read.unread).toBe(`no DigitalOcean API token: set ${DIGITALOCEAN_API_VARIABLE}`);
    expect(read.observations).toEqual([]);
    expect(calls).toEqual([]);
    expect((await readDigitalOceanAddresses(fetch, "   ")).unread).toContain("no DigitalOcean API token");
  });

  it("reads the reserved IPs and the droplets' public addresses, under the account's name", async () => {
    const { fetch, calls } = fakeFetch(doHealthy);
    const read = await readDigitalOceanAddresses(fetch, "dtoken");
    expect(read.unread).toBeUndefined();
    expect(read.name).toBe("Zysys");
    expect(read.account).toBe("Zysys");
    expect(read.observations.map((entry) => [entry.address, entry.kind, entry.state])).toEqual([
      ["159.65.47.218", "reserved_ip", "assigned"],
      ["104.236.33.38", "reserved_ip", "unassigned"],
      ["104.236.97.50", "droplet", "active"],
    ]);
    expect(read.observations.map((entry) => entry.address)).not.toContain("10.0.0.5");
    expect(read.observations[0]).toMatchObject({ cloud: "digitalocean", region: "nyc3", resource_name: "ds" });
    expect(calls.every((call) => call.authorization === "Bearer dtoken")).toBe(true);
    expect(calls.every((call) => call.url.startsWith("https://api.digitalocean.com/v2/"))).toBe(true);
  });

  it("follows the pages a list endpoint links to", async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.endsWith("/account")) return { body: DO_ACCOUNT };
      if (url.includes("/reserved_ips?page=2")) return { body: { reserved_ips: [{ ip: "104.236.33.38", droplet: null }] } };
      if (url.includes("/reserved_ips")) {
        return {
          body: {
            reserved_ips: [{ ip: "159.65.47.218", droplet: null }],
            links: { pages: { next: "https://api.digitalocean.com/v2/reserved_ips?page=2&per_page=200" } },
          },
        };
      }
      return { body: { droplets: [] } };
    });
    const read = await readDigitalOceanAddresses(fetch, "dtoken");
    expect(read.observations.map((entry) => entry.address)).toEqual(["159.65.47.218", "104.236.33.38"]);
    expect(calls.some((call) => call.url.includes("page=2"))).toBe(true);
  });

  it("never sends the token to a next-page link that leaves the API", async () => {
    // The source followed any `links.pages.next` string with the bearer token attached.
    const { fetch, calls } = fakeFetch((url) => {
      if (url.endsWith("/account")) return { body: DO_ACCOUNT };
      if (url.includes("/reserved_ips")) {
        return { body: { reserved_ips: [{ ip: "1.2.3.4", droplet: null }], links: { pages: { next: "https://evil.example/steal" } } } };
      }
      return { body: { droplets: [] } };
    });
    const read = await readDigitalOceanAddresses(fetch, "dtoken");
    expect(calls.map((call) => call.url).some((url) => url.includes("evil.example"))).toBe(false);
    expect(read.unread).toContain("next page link leaves the API");
    expect(read.observations.map((entry) => entry.address)).toEqual(["1.2.3.4"]);
  });

  it("reports the account unread when a list call fails, keeping the rows the other call returned", async () => {
    const { fetch } = fakeFetch((url) => {
      if (url.endsWith("/account")) return { body: DO_ACCOUNT };
      if (url.includes("/droplets")) return { status: 401, text: "Unauthorized" };
      return { body: RESERVED };
    });
    const read = await readDigitalOceanAddresses(fetch, "dtoken");
    expect(read.unread).toBe("droplets: 401: Unauthorized");
    expect(read.observations.map((entry) => entry.address)).toEqual(["159.65.47.218", "104.236.33.38"]);
  });

  it("still reads the lists when the token may not read the account", async () => {
    const { fetch } = fakeFetch((url) => (url.endsWith("/account") ? { status: 403, text: "Forbidden" } : doHealthy(url)));
    const read = await readDigitalOceanAddresses(fetch, "dtoken");
    expect(read.unread).toBeUndefined();
    expect(read.name).toBe("digitalocean");
    expect(read.account).toBeUndefined();
    expect(read.observations).toHaveLength(3);
  });

  it("records a network error or a non-JSON answer as the reason, not a thrown error", async () => {
    const broken: CloudFetch = async () => {
      throw new Error("getaddrinfo ENOTFOUND api.digitalocean.com\nstack");
    };
    const read = await readDigitalOceanAddresses(broken, "dtoken");
    expect(read.unread).toBe("reserved_ips: getaddrinfo ENOTFOUND api.digitalocean.com");
    const html = fakeFetch(() => ({ text: "<html>" }));
    expect((await readDigitalOceanAddresses(html.fetch, "dtoken")).unread).toContain("reserved_ips:");
  });

  it("rethrows an abort instead of calling the account unread", async () => {
    const controller = new AbortController();
    controller.abort();
    const slow: CloudFetch = async () => {
      throw new Error("aborted");
    };
    await expect(readDigitalOceanAddresses(slow, "dtoken", controller.signal)).rejects.toBeDefined();
  });
});

const CONFIG = "[default]\nregion = us-east-1\n\n[profile sah]\nregion = us-east-1\n\n[profile nq]\nregion = us-east-1\n";

describe("readCloudAddresses", () => {
  const deps = (runner: CloudRunner, extra: { config?: string | undefined; token?: string; fetch?: CloudFetch } = {}) => ({
    runner,
    readAwsConfig: async () => ("config" in extra ? extra.config : CONFIG),
    digitalOceanToken: extra.token,
    ...(extra.fetch === undefined ? {} : { fetch: extra.fetch }),
  });

  it("reads the named profiles and regions, and reports the addresses with their coverage", async () => {
    const { runner } = fakeAws(healthy);
    const inventory = await readCloudAddresses({ sources: ["aws"], profiles: ["sah"], regions: ["us-east-1"] }, deps(runner));
    expect(inventory.held).toHaveLength(6);
    expect(inventory.sources).toEqual([{
      name: "aws",
      status: "read",
      accounts: [{ cloud: "aws", name: "sah", account: ACCOUNT, regions: [{ region: "us-east-1", status: "read" }] }],
    }]);
  });

  it("reads every profile the config names when none is asked for, and keeps a profile it could not read visible", async () => {
    const { runner } = fakeAws((service, _region, profile) =>
      profile === "nq" && service === "sts get-caller-identity" ? failed("The SSO session has expired") : healthy(service));
    const inventory = await readCloudAddresses({ sources: ["aws"], regions: ["us-east-1"] }, deps(runner));
    expect(inventory.sources[0]?.status).toBe("read");
    expect(inventory.sources[0]?.accounts.map((entry) => entry.name)).toEqual(["default", "sah", "nq"]);
    expect(inventory.sources[0]?.accounts[2]?.unread).toBe("The SSO session has expired");
  });

  it("reports aws not_read, with the reason, when every profile is unreadable", async () => {
    const { runner } = fakeAws((service) => (service === "sts get-caller-identity" ? failed("no credentials") : healthy(service)));
    const inventory = await readCloudAddresses({ sources: ["aws"] }, deps(runner));
    expect(inventory.sources[0]).toMatchObject({ name: "aws", status: "not_read", reason: "no AWS profile could be read" });
    expect(inventory.held).toEqual([]);
  });

  it("reports aws not_read, with the reason, when the config names no profile and none was asked for", async () => {
    const { runner, calls } = fakeAws(healthy);
    const inventory = await readCloudAddresses({ sources: ["aws"] }, deps(runner, { config: undefined }));
    expect(inventory.held).toEqual([]);
    expect(inventory.sources).toEqual([{
      name: "aws",
      status: "not_read",
      reason: "no AWS profile: the AWS config names none, and none was asked for",
      accounts: [],
    }]);
    expect(calls).toEqual([]);
  });

  it("leaves a cloud out of the answer when it was not in scope", async () => {
    const { runner } = fakeAws(healthy);
    const inventory = await readCloudAddresses({ sources: ["aws"], profiles: ["sah"], regions: ["us-east-1"] }, deps(runner));
    expect(inventory.sources.map((source) => source.name)).toEqual(["aws"]);
  });

  it("reports digitalocean not_read, naming the token, when it is in scope and no token is set", async () => {
    const { runner, calls } = fakeAws(healthy);
    const inventory = await readCloudAddresses({ sources: ["digitalocean"] }, deps(runner));
    expect(inventory.held).toEqual([]);
    expect(inventory.sources).toEqual([{
      name: "digitalocean",
      status: "not_read",
      reason: "no DigitalOcean API token: set DIGITALOCEAN_TOKEN",
      accounts: [],
    }]);
    expect(calls).toEqual([]);
  });

  it("reads both clouds by default", async () => {
    const { runner } = fakeAws(healthy);
    const { fetch } = fakeFetch(doHealthy);
    const inventory = await readCloudAddresses({ profiles: ["sah"], regions: ["us-east-1"] }, deps(runner, { token: "t", fetch }));
    expect(inventory.sources.map((source) => [source.name, source.status])).toEqual([["aws", "read"], ["digitalocean", "read"]]);
    expect(inventory.held.some((row) => row.cloud === "digitalocean")).toBe(true);
  });

  it("reports digitalocean read, with the account's reason, when the token reached the account but a list failed", async () => {
    const { runner } = fakeAws(healthy);
    const { fetch } = fakeFetch((url) => (url.includes("/droplets") ? { status: 500, text: "boom" } : doHealthy(url)));
    const inventory = await readCloudAddresses({ sources: ["digitalocean"] }, deps(runner, { token: "t", fetch }));
    expect(inventory.sources[0]).toMatchObject({ name: "digitalocean", status: "read" });
    expect(inventory.sources[0]?.accounts[0]?.unread).toBe("droplets: 500: boom");
  });

  it("reports digitalocean not_read when the token is rejected everywhere", async () => {
    const { runner } = fakeAws(healthy);
    const { fetch } = fakeFetch(() => ({ status: 401, text: "Unauthorized" }));
    const inventory = await readCloudAddresses({ sources: ["digitalocean"] }, deps(runner, { token: "bad", fetch }));
    expect(inventory.sources[0]).toMatchObject({ name: "digitalocean", status: "not_read" });
  });
});

describe("coverageLine", () => {
  it("says every cloud was read only when nothing is missing", () => {
    expect(coverageLine([{ name: "aws", status: "read", accounts: [{ cloud: "aws", name: "sah", regions: [{ region: "us-east-1", status: "read" }] }] }]))
      .toBe("Every cloud in scope was read.");
  });

  it("names every unread cloud, account and region, and does not name a not_applicable one", () => {
    const line = coverageLine([
      { name: "digitalocean", status: "not_read", reason: "no token", accounts: [] },
      {
        name: "aws",
        status: "read",
        accounts: [
          { cloud: "aws", name: "nq", unread: "expired", regions: [] },
          {
            cloud: "aws",
            name: "sah",
            regions: [
              { region: "eu-west-3", status: "not_applicable", reason: "lightsail: no endpoint" },
              { region: "us-east-1", status: "not_read", reason: "elastic_ips: AuthFailure" },
            ],
          },
        ],
      },
    ]);
    expect(line).toContain("digitalocean NOT READ: no token");
    expect(line).toContain("aws account nq NOT READ: expired");
    expect(line).toContain("aws sah us-east-1 NOT READ: elastic_ips: AuthFailure");
    expect(line).not.toContain("eu-west-3");
  });

  it("says no cloud was in scope for an empty source list", () => {
    expect(coverageLine([])).toBe("No cloud was in scope.");
  });
});

/** A `pi` whose `zod` accepts any chain of builder calls; the real omptype is checked outside the suite. */
function stubPi(exec?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>) {
  const chain: unknown = new Proxy(() => chain, { get: () => chain, apply: () => chain });
  return { zod: new Proxy({}, { get: () => chain }), exec, cwd: "/" } as unknown as Parameters<typeof buildTool>[0];
}

describe("the tool", () => {
  it("returns the merged addresses, the coverage and a coverage line, and passes null fields as absent", async () => {
    const { runner } = fakeAws(healthy);
    const tool = buildTool(stubPi(), { runner, readAwsConfig: async () => CONFIG, digitalOceanToken: undefined });
    const result = await tool.execute("id", { sources: ["aws"], profiles: ["sah"], regions: ["us-east-1"] }, undefined, undefined, undefined);
    const details = result.details;
    expect(details.addresses.map((entry) => entry.address)).toEqual(["3.1.2.3", "5.6.7.8", "34.199.92.113", "54.198.191.19", "2600:1f18::1"]);
    expect(details.addresses[2]?.holders.map((holder) => holder.kind)).toEqual(["elastic_ip", "instance_public_address"]);
    expect(result.content[0]?.text.startsWith("Every cloud in scope was read.\n")).toBe(true);
    expect(JSON.parse(result.content[0]!.text.split("\n")[1]!)).toEqual(details);

    const nulls = await tool.execute("id", { sources: null, profiles: ["sah"], regions: null }, undefined, undefined, undefined);
    expect(nulls.details.sources.map((source) => source.name)).toEqual(["aws", "digitalocean"]);
  });

  it("says in the text, not only in details, that a cloud was not read", async () => {
    const { runner } = fakeAws(healthy);
    const tool = buildTool(stubPi(), { runner, readAwsConfig: async () => CONFIG, digitalOceanToken: undefined });
    const result = await tool.execute("id", { profiles: ["sah"], regions: ["us-east-1"] }, undefined, undefined, undefined);
    expect(result.content[0]?.text).toContain("digitalocean NOT READ: no DigitalOcean API token: set DIGITALOCEAN_TOKEN");
  });

  it("runs the AWS CLI through pi.exec with a timeout, and turns a killed call into a coverage reason", async () => {
    const seen: { command: string; args: string[]; options: unknown }[] = [];
    const exec = async (command: string, args: string[], options?: unknown) => {
      seen.push({ command, args, options });
      if (args[1] === "describe-addresses") return { stdout: "", stderr: "", code: -1, killed: true };
      return { ...healthy(`${args[0]} ${args[1]}`), killed: false };
    };
    const pi = { ...(stubPi() as object), exec } as unknown as Parameters<typeof buildTool>[0];
    const tool = buildTool(pi, { readAwsConfig: async () => CONFIG, digitalOceanToken: undefined });
    const result = await tool.execute("id", { sources: ["aws"], profiles: ["sah"], regions: ["us-east-1"] }, undefined, undefined, undefined);
    expect(seen[0]?.command).toBe("aws");
    expect(seen[0]?.options).toMatchObject({ timeout: 60_000, cwd: "/" });
    expect(result.details.sources[0]?.accounts[0]?.regions[0]).toMatchObject({
      status: "not_read",
      reason: "elastic_ips: timed out after 60 s",
    });
  });

  it("stops when the call is aborted instead of reporting every region unread", async () => {
    const controller = new AbortController();
    controller.abort();
    const exec = async () => ({ stdout: "", stderr: "", code: -1, killed: true });
    const pi = { ...(stubPi() as object), exec } as unknown as Parameters<typeof buildTool>[0];
    const tool = buildTool(pi, { readAwsConfig: async () => CONFIG, digitalOceanToken: undefined });
    await expect(
      tool.execute("id", { sources: ["aws"], profiles: ["sah"], regions: ["us-east-1"] }, undefined, undefined, controller.signal),
    ).rejects.toBeDefined();
  });

  it("sends heartbeats while a read is slow and clears the timer", async () => {
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    let started = 0;
    let cleared = 0;
    globalThis.setInterval = ((handler: () => void, _ms?: number) => {
      started += 1;
      handler();
      return 1;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = (() => {
      cleared += 1;
    }) as unknown as typeof clearInterval;
    try {
      const { runner } = fakeAws(healthy);
      const tool = buildTool(stubPi(), { runner, readAwsConfig: async () => CONFIG, digitalOceanToken: undefined });
      const updates: string[] = [];
      await tool.execute(
        "id",
        { sources: ["aws"], profiles: ["sah"], regions: ["us-east-1"] },
        (partial) => updates.push(partial.content[0]!.text),
        undefined,
        undefined,
      );
      expect(started).toBe(1);
      expect(cleared).toBe(1);
      expect(updates[0]).toContain("cloud_addresses is reading cloud accounts");
    } finally {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
  });

  it("has the shape of a custom tool and a description in the house style", () => {
    const tool = buildTool(stubPi());
    expect(tool.name).toBe("cloud_addresses");
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(DESCRIPTION).toContain("MUST read `sources`");
    expect(DESCRIPTION).toContain("Read-only");
  });
});

describe("isSafeRegion", () => {
  it("accepts dash-joined lowercase alphanumeric names and rejects everything else", () => {
    for (const region of ["us-east-1", "us-gov-west-1", "cn-north-1", "a-b"]) expect(isSafeRegion(region)).toBe(true);
    for (const region of ["", "us", "-us-east-1", "us-east-1-", "us--east", "US-east-1", "us_east-1", "us-east-1\n", "--profile", "us east-1"]) {
      expect(isSafeRegion(region)).toBe(false);
    }
  });
});
