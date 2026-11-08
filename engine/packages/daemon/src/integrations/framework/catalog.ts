export const FRAMEWORK_PIN = Object.freeze({
  repository: "leo-kuang-ai/spec-first",
  revision: "74655dc86b1270bb52239e0f8bc9517de7a7071c",
});

const entries = [
  ["autoresearch", "gated", "workflow", "A bounded goal and the upstream loop and ship gates"],
  ["spec-app-consistency-audit", "gated", "workflow", "The requested design sources and audit capabilities"],
  ["spec-brainstorm", "supported", "workflow", ""],
  ["spec-code-review", "supported", "workflow", ""],
  ["spec-commit-push-pr", "gated", "caller", "Explicit commit and landing authorization held by the calling workflow"],
  ["spec-commit", "gated", "caller", "Explicit commit authorization held by the calling workflow"],
  ["spec-compound-refresh", "gated", "user", "An explicit bounded knowledge refresh request"],
  ["spec-compound", "gated", "user", "Requested knowledge capture with verified source evidence"],
  ["spec-debug", "supported", "workflow", ""],
  ["spec-doc-review", "supported", "workflow", ""],
  ["spec-dogfood", "gated", "workflow", "Browser capability and an exact authorized origin"],
  ["spec-explain", "gated", "user", "An explicit teaching request"],
  ["spec-handoff", "gated", "user", "An explicit cross-session continuity request"],
  ["spec-ideate", "supported", "workflow", ""],
  ["spec-lfg", "gated", "user", "Explicit authorization for the full delivery pipeline"],
  ["spec-optimize", "gated", "workflow", "A measurable bounded optimization goal"],
  ["spec-plan", "supported", "workflow", ""],
  ["spec-polish", "gated", "workflow", "Browser capability and an authorized polish scope"],
  ["spec-pov", "supported", "workflow", ""],
  ["spec-prd", "supported", "workflow", ""],
  ["spec-product-pulse", "gated", "workflow", "Configured signal sources and their access gates"],
  ["spec-project-rules", "supported", "workflow", ""],
  ["spec-promote", "gated", "workflow", "A shipped feature and the requested promotion scope"],
  ["spec-prototype", "gated", "user", "A human-experienced prototype question"],
  ["spec-resolve-pr-feedback", "gated", "user", "Explicit PR feedback handling and separately scoped side effects"],
  ["spec-riffrec-feedback-analysis", "gated", "workflow", "An explicit feedback capture and any required media capabilities"],
  ["spec-rule-miner", "supported", "workflow", ""],
  ["spec-runtime-setup", "gated", "user", "Explicit host setup scope and upstream maintenance permissions"],
  ["spec-simplify-code", "supported", "workflow", ""],
  ["spec-strategy", "supported", "workflow", ""],
  ["spec-sweep", "gated", "user", "Configured feedback sources and their communication permissions"],
  ["spec-test-browser", "gated", "workflow", "Browser capability and an exact authorized origin"],
  ["spec-test-xcode", "gated", "user", "A macOS node with Xcode and simulator capability"],
  ["spec-work", "supported", "workflow", ""],
  ["spec-worktree", "gated", "caller", "A governed caller contract and explicit isolation authorization"],
  ["spec-write-skill", "gated", "user", "An explicit source skill package maintenance request"],
  ["spec-write-tasks", "supported", "workflow", ""],
  ["using-spec-first", "supported", "workflow", ""],
] as const;

export type FrameworkEntrypoint = (typeof entries)[number][0];
export type FrameworkEntry = Readonly<{
  name: FrameworkEntrypoint;
  status: "supported" | "gated" | "deferred";
  invocation: "workflow" | "user" | "caller";
  prerequisite: string;
  sourcePath: string;
}>;

export const FRAMEWORK_CATALOG: readonly FrameworkEntry[] = Object.freeze(entries.map(
  ([name, status, invocation, prerequisite]) => Object.freeze({
    name, status, invocation, prerequisite, sourcePath: `skills/${name}/SKILL.md`,
  }),
));

export function frameworkEntry(name: string): FrameworkEntry | undefined {
  return FRAMEWORK_CATALOG.find(entry => entry.name === name);
}
