const CROSS_CUTTING_AREA_COUNT = 3;
/** Work on these touches every part of a project, so only the whole suite covers it. */
const CROSS_CUTTING_WORDS = /\b(ci|build|builds|config|configuration|pipeline|toolchain|lockfile|dependencies)\b/i;

const areaOf = (path: string): string => (path.includes("/") ? path.slice(0, path.indexOf("/")) : ".");

/** Why the whole suite is the smallest regression that covers the work (it spans many areas, or is about config, the build or CI); undefined when it is not. */
export function crossCuttingReason(goal: string, changedFiles: readonly string[]): string | undefined {
  const areas = [...new Set(changedFiles.map(areaOf))];
  if (areas.length >= CROSS_CUTTING_AREA_COUNT) return `the changes span ${areas.join(", ")}`;
  const word = CROSS_CUTTING_WORDS.exec(goal)?.[1];
  return word === undefined ? undefined : `the goal is about ${word.toLowerCase()}`;
}
