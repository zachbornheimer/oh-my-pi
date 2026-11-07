/**
 * The vocabulary of `cloud_addresses`: which clouds are read, what holds an address, and the coverage rows that let a
 * caller tell "nothing holds this address" from "that account was never read".
 */

/** The clouds this tool has a reader for. Each names one entry in `sources` and one `cloud` on every holder. */
export const CLOUD_NAMES = ["aws", "digitalocean"] as const;
export type CloudName = (typeof CLOUD_NAMES)[number];

/** The kind of resource an address belongs to. */
export type AddressKind =
  | "elastic_ip"
  | "instance_public_address"
  | "lightsail_static_ip"
  | "lightsail_instance"
  | "reserved_ip"
  | "droplet";

/** The resource one address belongs to, without the address itself. */
export interface AddressHolder {
  cloud: CloudName;
  kind: AddressKind;
  /** The AWS profile the read ran under. */
  profile?: string;
  /** An AWS account id, or a DigitalOcean team. */
  account?: string;
  region?: string;
  /** The resource's own id: an allocation id, an instance id, a reserved IP. */
  resource_id?: string;
  resource_name?: string;
  /** `associated`, `unassociated`, `running`, `attached`, `active`, ... as the cloud reports it. */
  state?: string;
}

/** One address and one resource holding it: the row a reader reports, one per resource it finds. */
export interface AddressObservation extends AddressHolder {
  address: string;
}

/** Every resource that holds one address. */
export interface CloudAddress {
  address: string;
  holders: AddressHolder[];
}

/** `not_applicable` is a service the region does not offer (Lightsail outside its regions), not a gap. */
export type RegionStatus = "read" | "not_read" | "not_applicable";

export interface RegionRead {
  region: string;
  status: RegionStatus;
  /** Which read failed and the first line of its complaint. */
  reason?: string;
}

/** One account a source read, with one row per region it covered. */
export interface CloudAccount {
  cloud: CloudName;
  /** How the read addressed it: an AWS profile name, or a DigitalOcean team. */
  name: string;
  account?: string;
  /** Why the account was not read, when it was not; the account then holds no rows. */
  unread?: string;
  regions: RegionRead[];
}

/** One cloud's coverage. `not_read` means no address of that cloud can be claimed absent. */
export interface SourceRead {
  name: CloudName;
  status: "read" | "not_read";
  reason?: string;
  accounts: CloudAccount[];
}

export interface CloudAddressesInventory {
  held: AddressObservation[];
  sources: SourceRead[];
}

export interface CloudAddressesInput {
  sources?: CloudName[];
  profiles?: string[];
  regions?: string[];
}

export interface CloudAddressesOutput {
  addresses: CloudAddress[];
  sources: SourceRead[];
}

/** One finished process, as `pi.exec` reports it. `code` is -1 when the process was killed. */
export interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The command runner the AWS reads need; production binds it to `pi.exec`. */
export interface CloudRunner {
  run(command: string, args: readonly string[]): Promise<ProcessResult>;
}

/** What the DigitalOcean reads need from the network; tests pass a recorded one. */
export type CloudFetch = (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>>; readonly signal: AbortSignal },
) => Promise<Response>;
