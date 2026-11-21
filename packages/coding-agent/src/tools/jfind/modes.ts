/**
 * `find` modes. One tool, three engines, chosen by which arguments the call
 * supplies:
 *
 * - `query`            -> semantic: the judged cascade ({@link runCascade}).
 * - `pattern`          -> content: exact regex over file contents ({@link ContentSearch}).
 * - `glob` / `path` only -> names: exact file/directory matching ({@link NameSearch}).
 *
 * Content and names are deterministic and unjudged; semantic is judged and can
 * miss. They are exclusive so a caller never gets a judged answer where it asked
 * for an exact one.
 */
import { type } from "@oh-my-pi/omptype";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { hasGlobPathChars } from "../path-utils";
import type { GrepToolInput } from "./content-search";
import type { GlobToolInput } from "./name-search";

export const findSchema = type({
	"query?": "string",
	"grep_keywords?": "string[]",
	"pattern?": "string",
	"glob?": "string",
	"path?": "string",
	"case?": "boolean",
	"gitignore?": "boolean",
	"hidden?": "boolean",
	"limit?": "1 <= number.integer <= 200",
	"skip?": type("number").or("null"),
});

export type FindToolInput = typeof findSchema.infer;

export type FindMode = "semantic" | "content" | "names";

/** Arguments each mode reads; any other argument is ignored, and reported when its value was not a default. */
const MODE_ARGUMENTS: Record<FindMode, Partial<Record<keyof FindToolInput, true>>> = {
	semantic: { query: true, grep_keywords: true, path: true },
	content: { pattern: true, glob: true, path: true, case: true, gitignore: true, skip: true },
	names: { glob: true, path: true, hidden: true, gitignore: true, limit: true },
};

const MODE_PURPOSE: Record<FindMode, string> = {
	semantic: "`query` (+ `grep_keywords`, `path`): judged search by description; can miss, takes seconds",
	content: "`pattern` (+ `glob`, `path`, `case`, `gitignore`, `skip`): exact regex over file contents",
	names: "`glob` or `path` alone (+ `hidden`, `gitignore`, `limit`): exact file and directory names, also lists a directory",
};

const present = (value: unknown): boolean =>
	value !== undefined && value !== null && (typeof value !== "string" || value.trim() !== "");

/**
 * An argument left at the value it has when omitted, so sending it says nothing
 * about intent. Models echo every default they see in a schema; reporting those
 * would only teach them to send fewer arguments after wasting the call.
 */
function isDefaultValued(key: keyof FindToolInput, value: unknown): boolean {
	if (!present(value) && typeof value !== "string") return true;
	if (key === "case" || key === "gitignore") return value === true;
	if (key === "hidden") return value === false;
	if (key === "skip") return value === 0;
	if (key === "grep_keywords") return Array.isArray(value) && value.length === 0;
	return false;
}

/**
 * The mode a call's arguments point at; never throws, so approval can classify a call before it is validated.
 * An exact `pattern` outranks `query`: a caller that sent both has a literal to search for, and the exact
 * engine answers completely where the judged one can miss.
 */
export function inferFindMode(params: FindToolInput): FindMode {
	if (present(params.pattern)) return "content";
	if (present(params.query)) return "semantic";
	return present(params.glob) || present(params.path) ? "names" : "semantic";
}

/** The mode a call runs in, and what was dropped to get there. */
export interface ResolvedFind {
	mode: FindMode;
	/** One line per argument that did not apply and was not left at its default; empty when nothing meaningful was dropped. */
	notes: string[];
}

/**
 * Pick the mode a call runs in. Only a call with nothing to search for is refused;
 * every other combination runs in the likeliest mode, and what that mode did not
 * use is reported in {@link ResolvedFind.notes} so the answer's scope is never a surprise.
 */
export function resolveFindCall(params: FindToolInput): ResolvedFind {
	const mode = inferFindMode(params);
	if (mode === "semantic" && !present(params.query)) {
		throw new ToolError(
			"`find` needs something to search for; this call had no `query`, `pattern`, `glob` or `path`. " +
				Object.values(MODE_PURPOSE)
					.map(line => `- ${line}`)
					.join("\n"),
		);
	}
	const allowed = MODE_ARGUMENTS[mode];
	const notes: string[] = [];
	for (const key of Object.keys(params) as Array<keyof FindToolInput>) {
		if (key in allowed || isDefaultValued(key, params[key])) continue;
		notes.push(
			key === "query"
				? "`query` was not used: a `pattern` was given, and the exact content search answers completely where the judged `query` search can miss. Drop `pattern` to search by description instead."
				: `\`${key}\` does not apply to ${mode} mode and was not used (${MODE_PURPOSE[mode]}).`,
		);
	}
	return { mode, notes };
}

/**
 * Join `path` roots and `glob` patterns into the single scope the engines read:
 * every root x every glob, `;`-delimited. A `!exclusion` root passes through.
 */
export function scopeWithGlob(path: string | undefined, glob: string | undefined): string | undefined {
	if (!present(glob)) return path;
	const globs = glob!
		.split(";")
		.map(entry => entry.trim())
		.filter(Boolean);
	if (!present(path)) return globs.join(";");
	const roots = path!
		.split(";")
		.map(entry => entry.trim())
		.filter(Boolean);
	const joined: string[] = [];
	for (const root of roots) {
		if (root.startsWith("!")) {
			joined.push(root);
			continue;
		}
		if (hasGlobPathChars(root)) {
			throw new ToolError(
				`\`path\` "${root}" already contains a glob, so \`glob\` cannot also be applied to it. Put the whole pattern in \`glob\`, or make \`path\` a plain directory.`,
			);
		}
		const base = root.replace(/\/+$/, "");
		for (const pattern of globs) joined.push(`${base}/${pattern}`);
	}
	return joined.join(";");
}

/** `value` as a one-key object, or nothing: the engines' validators reject a key that is present but `undefined`. */
function only<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
	return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/** The content engine's input for a content-mode call. */
export function contentParams(params: FindToolInput): GrepToolInput {
	return {
		pattern: params.pattern ?? "",
		...only("path", scopeWithGlob(params.path, params.glob)),
		...only("case", params.case),
		...only("gitignore", params.gitignore),
		...only("skip", params.skip),
	};
}

/** The names engine's input for a names-mode call. */
export function nameParams(params: FindToolInput): GlobToolInput {
	return {
		...only("path", scopeWithGlob(params.path, params.glob)),
		...only("hidden", params.hidden),
		...only("gitignore", params.gitignore),
		...only("limit", params.limit),
	};
}
