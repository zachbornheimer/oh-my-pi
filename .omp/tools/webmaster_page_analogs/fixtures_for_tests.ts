import type {
  ContentMeasurement,
  PerformanceMeasurement,
  PerformanceMetrics,
  SeoMeasurement,
} from "./measurement.ts";
import type { ExecResult, ModelStep } from "./omp_model.ts";
import { loadZod } from "./zod_for_tests.ts";

export const PAGE = "https://example.org/membership";

export const seoMeasured = (over: Record<string, unknown> = {}): SeoMeasurement => ({
  status: "measured",
  final_url: PAGE,
  http_status: 200,
  title: "",
  meta_description: "",
  canonical: PAGE,
  robots_meta: "",
  x_robots_tag: "",
  headings: [{ level: 1, text: "Join the club" }],
  heading_level_skips: 0,
  schema_types: [],
  schema_errors: [],
  open_graph: [],
  internal_links: 4,
  external_links: 1,
  ...over,
}) as SeoMeasurement;

export const contentMeasured = (): ContentMeasurement => ({
  status: "measured",
  final_url: PAGE,
  http_status: 200,
  visible_text: "Join the club. Members get a monthly newsletter and discounts. Sign up today.",
  tag_ids: ["ga4"],
  fb_pixel: false,
  third_party_domains: ["cdn.example.net"],
  image_count_dom: 2,
  images_missing_alt: 1,
  generator: "WordPress 6.5",
});

export const metrics = (over: Partial<PerformanceMetrics> = {}): PerformanceMetrics => ({
  ttfb_ms: 300,
  lcp_ms: 6500,
  fcp_ms: 1200,
  inp_ms: 150,
  si_ms: 3000,
  tbt_ms: 100,
  cls: 0.02,
  perf_score: 0.4,
  weight_bytes: 3_000_000,
  image_count: 12,
  resource_summary: [],
  unused_css_bytes: 1000,
  unused_js_bytes: 2000,
  largest_image: null,
  render_blocking_count: 2,
  frameworks: [],
  third_party: null,
  opportunities: [],
  ...over,
});

export const performanceMeasured = (over: Partial<PerformanceMetrics> = {}): PerformanceMeasurement => ({
  status: "measured",
  source: "psi",
  form_factor: "mobile",
  metrics: metrics(over),
});

export const PURPOSE_JSON = {
  Purpose: {
    purpose: "Convince visitors to join the membership.",
    intentClass: "convert",
    primaryAudience: "Prospective members",
    primaryAction: "Join now",
    evidence: ["Sign up today."],
  },
};

export const SECTIONS_JSON = {
  Sections: [
    { ordinal: 1, name: "Hero", content: "Join the club", goal: "Hook", servesPurpose: "yes", note: null },
  ],
};

export const FINDINGS_JSON = {
  Findings: [{ measurement: "LCP is 6.5 s", consequence: "Slows the join button for mobile visitors." }],
};

/** A model step that records its prompts and answers each by `answer`; throws on an unanswered prompt. */
export function scriptedStep(answer: (prompt: string) => unknown | undefined): ModelStep & { prompts: string[] } {
  const prompts: string[] = [];
  const step = (async (prompt: string) => {
    prompts.push(prompt);
    const reply = answer(prompt);
    if (reply === undefined) throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`);
    return JSON.stringify(reply);
  }) as ModelStep & { prompts: string[] };
  step.prompts = prompts;
  return step;
}

/** Answers a findings-judgment prompt: every listed finding is real, medium, confidence 0.8. */
export function judgeAll(prompt: string): unknown | undefined {
  if (!prompt.includes("Respond as JSON: {\"findings\":[{\"id\"")) return undefined;
  const ids = [...prompt.matchAll(/^- (\S+): /gm)].map((m) => m[1]);
  return { findings: ids.map((id) => ({ id, real: true, severity: "medium", confidence: 0.8 })) };
}

/** Answers a ranking prompt: every listed finding priority 3, health needs_attention. */
export function rankAll(prompt: string): unknown | undefined {
  if (!prompt.includes('"priorities"')) return undefined;
  const ids = [...prompt.matchAll(/^- (\S+) \(/gm)].map((m) => m[1]);
  return { priorities: ids.map((id) => ({ id, level: 3 })), health: "needs_attention" };
}

export async function makePi() {
  const zod = await loadZod();
  const exec = async (): Promise<ExecResult> => {
    throw new Error("a test must not run a real process");
  };
  return { zod, exec, cwd: "/tmp" } as never;
}

export const texts = (result: { content: { text: string }[] }): string => result.content.map((c) => c.text).join("");
