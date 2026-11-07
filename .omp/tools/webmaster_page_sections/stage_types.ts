import type {
  AccessibilityMeasurement,
  ContentMeasurement,
  FormFactor,
  LinksMeasurement,
  PerformanceMeasurement,
  PrivacyMeasurement,
  ScreenshotMeasurement,
  SeoMeasurement,
} from "./measurement.ts";
import type { ModelStep } from "./omp_model.ts";
import type { Zod } from "./zod_type.ts";

/** The page probes a stage reads; each already carries the call's abort signal. A stage names only the ones it uses. */
export interface Probes {
  seo(url: string): Promise<SeoMeasurement>;
  content(url: string): Promise<ContentMeasurement>;
  performance(url: string, formFactor: FormFactor): Promise<PerformanceMeasurement>;
  accessibility(url: string): Promise<AccessibilityMeasurement>;
  links(url: string): Promise<LinksMeasurement>;
  privacy(url: string): Promise<PrivacyMeasurement>;
  screenshot(url: string): Promise<ScreenshotMeasurement>;
}

/** What every stage needs besides its probes: omp's zod, the model step, its question file and the signal. */
export interface StageEnv {
  readonly z: Zod;
  readonly step: ModelStep;
  readonly signal?: AbortSignal;
  /** Called with a short progress line as a stage moves between its steps. */
  readonly progress?: (line: string) => void;
}
