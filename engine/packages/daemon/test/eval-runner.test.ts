import { describe, it, expect } from "vitest";
import { runEvals } from "./helpers/eval-runner.js";
import { FakeProvider } from "./helpers/eval-provider.js";
import type { EvalCase } from "./helpers/eval-grader.js";

// slice-07 R6 — RED-first pins for the runner's accounting. Against the "nothing ran" stub these
// fail; GREEN lands when runEvals actually drives the provider + grader and tallies outcomes.

const CASES: EvalCase[] = [
  {
    id: "s1", name: "pulls the right ref", category: "selection", prompt: "P1",
    expectedPatterns: ["multi-agent context get\\s+pods/orchestration-team"],
  },
  {
    id: "s2", name: "pulls the wrong ref", category: "selection", prompt: "P2",
    expectedPatterns: ["multi-agent context get\\s+pods/orchestration-team"],
  },
  {
    id: "l1", name: "loads before acting", category: "loading", prompt: "P3",
    expectedPatterns: ["multi-agent context get\\s+pods/review-team"],
    order: { getPattern: "multi-agent context get\\s+pods/review-team", actionPattern: "multi-agent watchdog register" },
  },
];

describe("eval-runner", () => {
  it("drives each case through provider + grader and tallies pass/fail by category", async () => {
    const provider = new FakeProvider({
      P1: "multi-agent context get pods/orchestration-team\nmulti-agent team start",
      P2: "multi-agent context get process/context-engineering\nmulti-agent team start",
      P3: "multi-agent context get pods/review-team\nmulti-agent team diff",
    });
    const s = await runEvals(CASES, provider);
    expect(s.total).toBe(3);
    expect(s.passed).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.errored).toBe(0);
    expect(s.byCategory.selection).toEqual({ total: 2, passed: 1 });
    expect(s.byCategory.loading).toEqual({ total: 1, passed: 1 });
    expect(s.outcomes).toHaveLength(3);
  });

  it("records error outcomes (not graded FAILs) when the provider cannot execute", async () => {
    const s = await runEvals(CASES, new FakeProvider({}));
    expect(s.errored).toBe(3);
    expect(s.passed).toBe(0);
    expect(s.failed).toBe(0);
  });
});
