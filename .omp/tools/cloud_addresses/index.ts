import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { heldAddresses } from "./merge.ts";
import { readCloudAddresses } from "./readers.ts";
import {
  CLOUD_NAMES,
  type CloudAddressesInput,
  type CloudAddressesOutput,
  type CloudFetch,
  type CloudName,
  type CloudRunner,
  type SourceRead,
} from "./types.ts";

/**
 * Native `cloud_addresses` custom tool: a port of the Mastra capability `cloud.addresses` together with the host-side
 * readers the Mastra CLI ran before it. Self-contained: no Mastra, no gateway, no `capability` CLI.
 */

const HEARTBEAT_MS = 15_000;
/** One `aws` call. A region's EC2 or Lightsail endpoint that does not answer is a coverage gap, not a hang. */
const AWS_CALL_TIMEOUT_MS = 60_000;

export const DESCRIPTION =
  "Read the public addresses the owner's cloud accounts hold, so a DNS record's target can be told from one of ours: "
  + "each AWS profile's Elastic IPs, running instances' public IPv4 and IPv6 addresses, Lightsail static IPs and Lightsail instances, "
  + "and DigitalOcean's reserved IPs and droplets' public IPv4 addresses. Use it before calling a record dangling or deletable. "
  + "It attributes and never judges. "
  + "`{\"sources\":[\"aws\"],\"profiles\":[\"sah\"],\"regions\":[\"us-east-1\"]}`: every field is optional; `sources` defaults to `aws` and `digitalocean`, "
  + "`profiles` to every profile the AWS config names (`~/.aws/config`, or AWS_CONFIG_FILE), `regions` to every region each account lists as opted in. "
  + "An unnarrowed read runs four `aws` calls per region per profile and takes minutes: narrow `regions` when the question is about a few. "
  + "DigitalOcean is read with DIGITALOCEAN_TOKEN from the omp process environment; without it that cloud is reported `not_read`. "
  + "The result has `addresses` (one entry per address, IPv4 in numeric order, each with every holder) and `sources` (per cloud, account and region: `read`, `not_read` or `not_applicable`, with the reason). "
  + "MUST read `sources` before concluding anything from an absence: an address missing from `addresses` was held by none of the sources that were read, "
  + "and an unread account or region supports no such claim. "
  + "Read-only: spawns the `aws` CLI (60 s per call) and calls api.digitalocean.com; writes nothing, never returns private addresses, hostnames or domains, "
  + "and does not decide whether a record should exist. For DNS records use webmaster_site_dns.";

type ToolApi = Parameters<CustomToolFactory>[0];
type Update = (partial: { content: { type: "text"; text: string }[]; details?: unknown }) => void;

/** The test seam: every outside thing the tool touches. Production passes none and gets `pi.exec`, the real files and network. */
export interface CloudAddressesDeps {
  readonly runner?: CloudRunner;
  readonly readAwsConfig?: () => Promise<string | undefined>;
  readonly digitalOceanToken?: string | undefined;
  readonly fetch?: CloudFetch;
}

/** The AWS CLI through `pi.exec`: a killed call (timeout) is a failed read, an aborted call stops the whole tool. */
function execRunner(pi: ToolApi, signal: AbortSignal | undefined): CloudRunner {
  return {
    async run(command, args) {
      signal?.throwIfAborted();
      const result = await pi.exec(command, [...args], { signal, timeout: AWS_CALL_TIMEOUT_MS, cwd: pi.cwd });
      if (result.killed) {
        signal?.throwIfAborted();
        return { code: -1, stdout: "", stderr: `timed out after ${AWS_CALL_TIMEOUT_MS / 1000} s` };
      }
      return { code: result.code, stdout: result.stdout, stderr: result.stderr };
    },
  };
}

async function readAwsConfigFile(): Promise<string | undefined> {
  const path = process.env.AWS_CONFIG_FILE ?? join(homedir(), ".aws", "config");
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** One line a reader sees before the JSON: what could not be read, so an absence is never mistaken for an empty read. */
export function coverageLine(sources: readonly SourceRead[]): string {
  if (sources.length === 0) return "No cloud was in scope.";
  const gaps: string[] = [];
  for (const source of sources) {
    if (source.status === "not_read") gaps.push(`${source.name} NOT READ: ${source.reason ?? "no reason given"}`);
    for (const account of source.accounts) {
      if (account.unread !== undefined) gaps.push(`${source.name} account ${account.name} NOT READ: ${account.unread}`);
      for (const region of account.regions) {
        if (region.status === "not_read") {
          gaps.push(`${source.name} ${account.name} ${region.region} NOT READ: ${region.reason ?? "no reason given"}`);
        }
      }
    }
  }
  return gaps.length === 0
    ? "Every cloud in scope was read."
    : `Coverage gaps (an absence from these is not evidence): ${gaps.join("; ")}.`;
}

/** Build the tool; `deps` is the test seam. */
export function buildTool(pi: ToolApi, deps: CloudAddressesDeps = {}) {
  const z = pi.zod;
  return {
    name: "cloud_addresses",
    label: "Cloud Addresses",
    description: DESCRIPTION,
    parameters: z.object({
      sources: z
        .array(z.enum(CLOUD_NAMES))
        .min(1)
        .nullable()
        .optional()
        .describe("Clouds to read: `aws`, `digitalocean`. Omit for both."),
      profiles: z
        .array(z.string().min(1))
        .min(1)
        .nullable()
        .optional()
        .describe("AWS profile names to read, such as `[\"sah\",\"nq\"]`. Omit for every profile the AWS config names, `[default]` included."),
      regions: z
        .array(z.string().min(1))
        .min(1)
        .nullable()
        .optional()
        .describe("AWS regions to read, such as `[\"us-east-1\"]`. Omit for every region each account lists as opted in; narrowing is the way to a fast read."),
    }),

    async execute(
      _toolCallId: string,
      params: { sources?: CloudName[] | null; profiles?: string[] | null; regions?: string[] | null },
      onUpdate: Update | undefined,
      _ctx: unknown,
      signal: AbortSignal | undefined,
    ) {
      const request: CloudAddressesInput = {
        ...(params.sources == null ? {} : { sources: params.sources }),
        ...(params.profiles == null ? {} : { profiles: params.profiles }),
        ...(params.regions == null ? {} : { regions: params.regions }),
      };
      const began = Date.now();
      const beat = setInterval(() => {
        onUpdate?.({
          content: [{ type: "text", text: `cloud_addresses is reading cloud accounts (${Math.round((Date.now() - began) / 1000)} s)` }],
          details: { status: "running" },
        });
      }, HEARTBEAT_MS);
      try {
        const inventory = await readCloudAddresses(request, {
          runner: deps.runner ?? execRunner(pi, signal),
          readAwsConfig: deps.readAwsConfig ?? readAwsConfigFile,
          digitalOceanToken: "digitalOceanToken" in deps ? deps.digitalOceanToken : process.env.DIGITALOCEAN_TOKEN,
          ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
          ...(signal === undefined ? {} : { signal }),
        });
        const output: CloudAddressesOutput = {
          addresses: heldAddresses(inventory.held),
          sources: inventory.sources,
        };
        return {
          content: [{ type: "text" as const, text: `${coverageLine(output.sources)}\n${JSON.stringify(output)}` }],
          details: output,
        };
      } finally {
        clearInterval(beat);
      }
    },
  };
}

const factory: CustomToolFactory = (pi) => buildTool(pi);

export default factory;
