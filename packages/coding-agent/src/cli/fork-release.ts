/**
 * Fork release identity and its update source.
 *
 * The fork's release build bakes its release tag into the binary as
 * `PI_BUILD_IDENTITY` (`build-<YYYYMMDDHHMMSS>-<upstream7>-<build7>`, the second
 * line of `omp --version`). A build that carries one updates from the fork's own
 * Latest release through mise, never from upstream's npm package or build
 * service, which would replace the fork with a build that lacks its carried
 * changes. Builds without an identity (upstream releases, source checkouts) are
 * not fork builds and keep the upstream update path.
 */

import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { compareVersions } from "@oh-my-pi/pi-utils/version";

/** The repository the fork's release builds publish to. */
export const FORK_OWNER = "zachbornheimer";
export const FORK_REPO = "oh-my-pi";

/** The mise tool that installs the fork's releases. */
export const FORK_MISE_TOOL = `github:${FORK_OWNER}/${FORK_REPO}`;

/** A build older than this has missed a scheduled release (releases ship twice a day). */
export const STALE_BUILD_MS = 24 * 60 * 60_000;

const TAG_PREFIX = "build-";
const TAG = /^build-(\d{8})(\d{6})?-[0-9A-Za-z._-]+$/;

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The release a fork binary was built as. */
export interface ForkBuild {
	/** Release tag, e.g. `build-20261125104043-e1a9f4b-2937770`. */
	tag: string;
	/** UTC instant in the tag; a date-only tag counts as midnight. */
	builtAt: number;
}

/** The instant a release tag names, or undefined when it is not a fork release tag. */
export function parseBuildTag(tag: string | undefined): number | undefined {
	const match = TAG.exec(tag?.trim() ?? "");
	const date = match?.[1];
	if (!date) return undefined;
	const time = match[2] ?? "000000";
	const epoch = Date.UTC(
		Number(date.slice(0, 4)),
		Number(date.slice(4, 6)) - 1,
		Number(date.slice(6, 8)),
		Number(time.slice(0, 2)),
		Number(time.slice(2, 4)),
		Number(time.slice(4, 6)),
	);
	return Number.isNaN(epoch) ? undefined : epoch;
}

/** Parse a build identity; undefined for an empty or foreign one. */
export function parseForkIdentity(identity: string | undefined): ForkBuild | undefined {
	const tag = identity?.trim();
	const builtAt = parseBuildTag(tag);
	return tag && builtAt !== undefined ? { tag, builtAt } : undefined;
}

/** The fork build this process is, from the identity the release build baked in. */
export function currentForkBuild(): ForkBuild | undefined {
	return parseForkIdentity(process.env.PI_BUILD_IDENTITY);
}

/** The running release's label for update comparisons: the fork's release tag, else the package version. */
export function currentReleaseLabel(): string {
	return currentForkBuild()?.tag ?? VERSION;
}

/** Whether release label `candidate` is newer than `current`; both fork tags, or both package versions. */
export function isNewerRelease(candidate: string, current: string = currentReleaseLabel()): boolean {
	if (parseBuildTag(candidate) !== undefined || parseBuildTag(current) !== undefined) {
		return compareBuildTags(candidate, current) > 0;
	}
	return compareVersions(candidate, current) > 0;
}

/** The release tag on the identity line of `omp --version` output; undefined when it has none. */
export function parseReportedBuildTag(output: string): string | undefined {
	for (const line of output.split(/\r?\n/)) {
		if (parseBuildTag(line) !== undefined) return line.trim();
	}
	return undefined;
}

/** Negative, zero or positive as `a` was built before, with, or after `b`; tags without a stamp compare as equal. */
export function compareBuildTags(a: string, b: string): number {
	const left = parseBuildTag(a);
	const right = parseBuildTag(b);
	if (left === undefined || right === undefined) return 0;
	return left - right;
}

/** The mise version string for a release tag: the tool's `version_prefix` strips `build-`. */
export function forkMiseVersion(tag: string): string {
	return tag.startsWith(TAG_PREFIX) ? tag.slice(TAG_PREFIX.length) : tag;
}

function describeAge(ms: number): string {
	const hours = Math.floor(ms / 3_600_000);
	return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/**
 * The startup warning for a build more than {@link STALE_BUILD_MS} old; undefined
 * when it is fresh. Judged from the tag alone, so it needs no network.
 */
export function staleBuildWarning(build: ForkBuild, now = Date.now()): string | undefined {
	const age = now - build.builtAt;
	if (age <= STALE_BUILD_MS) return undefined;
	return `This omp build is ${describeAge(age)} old (${build.tag}); releases ship twice a day. Run "omp update" to install the latest.`;
}

/** The fork's newest published (non-prerelease) release tag. */
export async function fetchLatestForkReleaseTag(
	options: { timeoutMs?: number; fetchImpl?: Fetch; token?: string } = {},
): Promise<string> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const headers: Record<string, string> = {
		accept: "application/vnd.github+json",
		"x-github-api-version": "2022-11-28",
	};
	const token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	if (token) headers.authorization = `Bearer ${token}`;
	const response = await fetchImpl(`https://api.github.com/repos/${FORK_OWNER}/${FORK_REPO}/releases/latest`, {
		headers,
		signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
	});
	if (!response.ok)
		throw new Error(`GitHub answered ${response.status} for ${FORK_OWNER}/${FORK_REPO}'s latest release`);
	const body: unknown = await response.json();
	const tag = typeof body === "object" && body !== null && "tag_name" in body ? body.tag_name : undefined;
	if (typeof tag !== "string" || parseBuildTag(tag) === undefined) {
		throw new Error(`${FORK_OWNER}/${FORK_REPO}'s latest release has no build tag (got ${JSON.stringify(tag)})`);
	}
	return tag;
}
