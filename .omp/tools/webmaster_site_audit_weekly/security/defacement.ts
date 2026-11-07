import { readFileSync } from "node:fs";
import { answer, securityFinding, type SecurityFinding, type Verdict } from "./check.ts";
import { type ModelStep, askJson } from "./omp_model.ts";
import { type SitePublicFiles } from "./public_files.ts";
import { apexOf, succeeded } from "./net.ts";
import type { ScreenshotMeasurement } from "./screenshot.ts";

export const CHECK = "webmaster.security.site.defacement";

/** Phrases defacers sign their pages with, matched without case; the caller adds its own. */
export const DEFACEMENT_PHRASES = ["Hacked By", "H4ck3d By", "Defaced By", "Greetz to"] as const;

/** The most characters of a page's rendered text that are kept. */
export const VISIBLE_TEXT_CAP = 20_000;

/** The home page's own content: its rendered text, read from one fetch. */
export type HomePage =
  | { status: "measured"; final_url: string; http_status: number; visible_text: string }
  | { status: "unmeasured"; reason: string };

/** The page's rendered text: head, scripts, styles, noscript, comments and tags stripped, whitespace collapsed, capped. */
export function visibleText(html: string): string {
  return html
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, VISIBLE_TEXT_CAP);
}

const phraseIn = (text: string, phrases: readonly string[]): string | undefined => {
  const lower = text.toLowerCase();
  return phrases.find((phrase) => lower.includes(phrase.toLowerCase()));
};

/** The home page's rendered text and the drop pages that answered, when they carry a defacer's signature. */
export function defacementVerdict(homePage: HomePage | undefined, publicFiles: SitePublicFiles | undefined, extraPhrases: readonly string[] = []): Verdict {
  if (homePage?.status !== "measured" && publicFiles?.status !== "measured") {
    return { unmeasured: homePage?.reason ?? publicFiles?.reason ?? "neither the home page nor the drop pages were read" };
  }
  const phrases = [...DEFACEMENT_PHRASES, ...extraPhrases];
  const onHome = homePage?.status === "measured" ? phraseIn(homePage.visible_text, phrases) : undefined;
  const marked = [
    ...(onHome === undefined ? [] : [`the home page says "${onHome}"`]),
    ...(publicFiles?.status === "measured"
      ? publicFiles.files.filter((file) => file.purpose === "drop" && succeeded(file)).flatMap((file) => {
        const phrase = phraseIn(file.body, phrases);
        return phrase === undefined ? [] : [`${file.path} says "${phrase}"`];
      })
      : []),
  ];
  if (marked.length === 0) {
    // A pass needs both sources: a home page that was not read could be the defaced one.
    const unread = [
      ...(homePage?.status === "measured" ? [] : [`the home page was not read (${homePage?.reason ?? "no reading"})`]),
      ...(publicFiles?.status === "measured" ? [] : [`the drop pages were not read (${publicFiles?.reason ?? "no reading"})`]),
    ];
    return unread.length === 0 ? [] : { unmeasured: unread.join("; ") };
  }
  return [securityFinding(
    "security.site.defacement",
    "high",
    `Defacement text is live: ${marked.join("; ")}.`,
    "Put the site in maintenance mode or behind a block page now, and hand it to the hosting agent: a defaced site has an attacker with write access.",
    "Restore from a known-good backup after the entry point is closed, then rotate every credential.",
  )];
}

/** A yes at or above this probability, on either question about the picture, is a high finding. */
export const SEEN_HIGH_AT = 0.8;
/** A yes at or above this probability, and below `SEEN_HIGH_AT`, is a medium finding. */
export const SEEN_MEDIUM_AT = 0.5;
const SEEN = ["LeftMessage", "DefacerStyle"] as const;

interface QuestionFile {
  LeftMessage: { instructions: string; criteria: Record<string, string> };
  DefacerStyle: { instructions: string; criteria: Record<string, string> };
}

let loaded: QuestionFile | undefined;
function questions(): QuestionFile {
  if (loaded === undefined) {
    const parsed = Bun.YAML.parse(readFileSync(new URL("./webmaster_security_site_defacement.yaml", import.meta.url), "utf8")) as Partial<QuestionFile>;
    if (parsed.LeftMessage === undefined || parsed.DefacerStyle === undefined) throw new Error("webmaster_security_site_defacement.yaml needs LeftMessage and DefacerStyle");
    loaded = parsed as QuestionFile;
  }
  return loaded;
}

const REPLY_SCHEMA = {
  type: "object",
  properties: {
    LeftMessage: { type: "number", minimum: 0, maximum: 1, description: "Probability the LeftMessage answer is true." },
    DefacerStyle: { type: "number", minimum: 0, maximum: 1, description: "Probability the DefacerStyle answer is true." },
  },
  required: ["LeftMessage", "DefacerStyle"],
  additionalProperties: false,
} as const;

/** What the model reads next to the attached picture: both questions with their criteria, then the reply schema. */
export function pictureQuestion(site: string): string {
  const file = questions();
  const asked = SEEN.map((field) => {
    const question = file[field];
    const criteria = Object.entries(question.criteria).map(([label, rubric]) => `- ${String(label)}: ${rubric}`).join("\n");
    return `${field}: ${question.instructions.trim()}\nAnswers:\n${criteria}\nGive the probability (0 to 1) that the answer is true.`;
  });
  return [
    "## Defacement",
    `The attached image is \`screenshot\`, the first screen of the home page of ${site}. Look at the image and answer both questions.`,
    ...asked,
    `Respond as JSON matching this schema:\n${JSON.stringify(REPLY_SCHEMA)}`,
  ].join("\n\n");
}

const probability = (value: unknown, where: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${where}: expected a number from 0 to 1`);
  return value;
};

/** The model's reply as one probability per question. Throws, naming the field, when it is not that. */
export function parseSeen(value: unknown): Record<(typeof SEEN)[number], number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("reply: expected a JSON object");
  const reply = value as Record<string, unknown>;
  return { LeftMessage: probability(reply["LeftMessage"], "LeftMessage"), DefacerStyle: probability(reply["DefacerStyle"], "DefacerStyle") };
}

/** Judges one picture: `step` is the model call that reads it. Fails open: no answer is `unmeasured` with why, never a pass. */
export async function seenVerdict(
  site: string,
  picture: Extract<ScreenshotMeasurement, { status: "measured" }>,
  step: ModelStep,
  signal?: AbortSignal,
): Promise<readonly SecurityFinding[] | { readonly unmeasured: string }> {
  let odds: Record<(typeof SEEN)[number], number>;
  try {
    odds = await askJson(step, pictureQuestion(site), parseSeen, signal === undefined ? {} : { signal });
  } catch (error) {
    signal?.throwIfAborted();
    return { unmeasured: `the screenshot could not be judged: ${error instanceof Error ? error.message : String(error)}` };
  }
  const [field, top] = SEEN.map((name) => [name, odds[name]] as const).reduce((best, next) => (next[1] > best[1] ? next : best));
  if (!(top >= SEEN_MEDIUM_AT)) return [];
  return [securityFinding(
    "security.site.defacement",
    top >= SEEN_HIGH_AT ? "high" : "medium",
    `The home page looks defaced to the model (${field}, P(yes) ${top.toFixed(2)}, as the model states it; ${picture.final_url}, taken ${picture.captured_at}).`,
    "Look at the home page now; if it is defaced, put the site in maintenance mode or behind a block page and hand it to the hosting agent: a defaced site has an attacker with write access.",
    "Restore from a known-good backup after the entry point is closed, then rotate every credential.",
  )];
}

export interface DefacementInput {
  readonly site: string;
  readonly home_page?: HomePage;
  readonly public_files?: SitePublicFiles;
  readonly defacement_patterns?: readonly string[];
}

/**
 * The check's verdict. A phrase on the home page text or a drop page fails it without a model call. Otherwise the picture
 * of the home page is judged by sight, and a pass needs every source read: the home page text, the drop pages and the
 * picture. `picture` takes the screenshot only when it is needed and answers the model step that reads it.
 */
export async function defacementVerdictBySight(
  input: DefacementInput,
  picture: () => Promise<{ screenshot: ScreenshotMeasurement; step?: ModelStep }>,
  signal?: AbortSignal,
): Promise<Verdict> {
  const text = defacementVerdict(input.home_page, input.public_files, input.defacement_patterns);
  if (!("unmeasured" in text) && text.length > 0) return text;
  const { screenshot, step } = await picture();
  if (screenshot.status !== "measured" || step === undefined) {
    const why = `the home page was not pictured (${screenshot.status === "measured" ? "no model step" : screenshot.reason})`;
    return { unmeasured: "unmeasured" in text ? `${text.unmeasured}; ${why}` : why };
  }
  const seen = await seenVerdict(apexOf(input.site), screenshot, step, signal);
  if (!("unmeasured" in seen) && seen.length > 0) return seen;
  if ("unmeasured" in seen) return { unmeasured: "unmeasured" in text ? `${text.unmeasured}; ${seen.unmeasured}` : seen.unmeasured };
  return text;
}

export { answer };
