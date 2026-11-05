import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createInterfaceI18n, type InterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import type { TeamAttemptView, TeamOwnerRead, TeamReviewView, TeamRun } from "@openrig/daemon/team-control";
import { Overview, compactTokens, observedCost, stageGroupState, verifiedChecks } from "../overview.js";

/**
 * Slice A — the Overview.
 *
 * The rule these tests exist for: a value the read model does not publish is shown as unknown,
 * never as zero, because zero is a measured result and the screen must not invent one.
 */

const run: TeamRun = {
  id: "RUN-0142", rigId: "work-board", displayName: "Add the status filter", bindingDigest: "binding", state: "approved", stateReason: null, stateReasonKey: null, phase: "delivery",
  entityVersion: 3, activeMs: 0, accountedAt: null, retriesUsed: 0, reviewRoundsUsed: 0, reviewerSeat: null,
  usage: { activeMs: 0, inputTokens: { value: null, reason: "Not published" }, outputTokens: { value: null, reason: "Not published" }, costUsd: { value: null, reason: "Not published" } },
  createdAt: "2026-10-31T00:00:00.000Z", updatedAt: "2026-10-31T00:00:00.000Z",
  binding: { artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
    planRef: "docs/plans/fixture.md", planDigest: "a".repeat(64), repository: { root: "/fixture", identity: "fixture/repo" },
    readPaths: [], writePaths: [], roles: ["lead", "implementer", "reviewer"], policyRevision: 1, policyFingerprint: "b".repeat(64),
    limits: { maxSessions: 3, maxActiveMs: 60_000, maxRetries: 1, maxReviewRounds: 2 } },
};

function task(id: string, state: TeamReviewView["queueState"], verified: number | null, total: number | null): TeamReviewView {
  return { taskId: id, qitemId: `q-${id}`, role: "implementer", queueState: state, displayName: "Sample task",
    displayNameParts: { kind: "task" }, title: null, dependencies: [],
    criteria: { verified, total, source: verified === null ? null : "team_queue_authority.evidence_json" },
    currentCandidateDigest: null, rounds: 0, openP0P1: 0, verdicts: [], reviewAvailable: false, acceptance: null };
}

/** An attempt whose usage no producer observed, which is the state a fresh attempt is in. */
function attempt(overrides: Partial<TeamAttemptView> = {}): TeamAttemptView {
  return { attemptId: "a1", runId: run.id, taskId: "T-102", qitemId: "q-T-102", role: "implementer", provider: "claude",
    state: "stopped", unknownReason: null, session: null, createdAt: "2026-10-31T00:00:00.000Z",
    usage: { activeMs: 0, inputTokens: { value: null, reason: "not reported" }, outputTokens: { value: null, reason: "not reported" },
      costUsd: { value: null, reason: "not reported" } }, failure: null, ...overrides };
}

function read(overrides: Partial<TeamOwnerRead> = {}): TeamOwnerRead {
  return { schema: "multi-agent-team-read/v1", protocolVersion: "1.0", runId: run.id, generatedAt: "2026-10-31T00:00:00.000Z",
    run, workflow: { current: "execution", stages: [
      { stage: "setup-checks", state: "complete", evidence: "run" }, { stage: "plan-approved", state: "complete", evidence: "approval" },
      { stage: "assignments-derived", state: "complete", evidence: "tasks" }, { stage: "execution", state: "active", evidence: "tasks" },
      { stage: "review", state: "pending", evidence: "tasks" }, { stage: "integration-verification", state: "pending", evidence: "tasks" },
      { stage: "delivery-decision", state: "not-started", evidence: "approval" } ] },
    tasks: [], seats: [], attempts: [], approvals: [], logs: [], replay: { retainedFrom: 1, latestSeq: 1 }, ...overrides };
}

async function show(value: TeamOwnerRead | undefined, locale: "en" | "zh-CN" = "en", onOpenReviews = () => {}): Promise<InterfaceI18n> {
  const language = await createInterfaceI18n({ preference: { read: () => locale, write() {} } });
  render(<I18nextProvider i18n={language.instance}>
    <Overview read={value} run={value?.run} now={Date.now()} onInspect={() => {}} onOpenTasks={() => {}} onOpenReviews={onOpenReviews} />
  </I18nextProvider>);
  return language;
}

describe("overview summary", () => {
  it.each(["en", "zh-CN"] as const)("renders unknown tokens and cost as an em dash, never zero (%s)", async locale => {
    const language = await show(read(), locale);
    const summary = screen.getByRole("region", { name: language.t("overview.summary") });
    const cell = (key: string) => within(summary).getByText(language.t(key as "overview.tokens")).parentElement!;
    expect(within(cell("overview.tokens")).getByText("—")).toBeTruthy();
    expect(within(cell("overview.observedCost")).getByText("—")).toBeTruthy();
    expect(within(summary).queryByText("$0.00")).toBeNull();
    expect(within(summary).queryByText("0K")).toBeNull();
  });

  it("shows the run's published counts and observed cost", async () => {
    const value = read({ tasks: [task("T-101", "done", 2, 2), task("T-102", "in-progress", 1, 4), task("T-104", "blocked", null, null)],
      attempts: [attempt({ state: "running" })] });
    value.run = { ...run, usage: { activeMs: 0, inputTokens: { value: 100_000, reason: null }, outputTokens: { value: 28_000, reason: null }, costUsd: { value: 1.84, reason: null } } };
    const language = await show(value);
    const summary = screen.getByRole("region", { name: language.t("overview.summary") });
    expect(within(summary).getByText("128K")).toBeTruthy();
    expect(within(summary).getByText("$1.84")).toBeTruthy();
    const cell = (key: string) => within(summary).getByText(language.t(key as "overview.tasks")).parentElement!;
    expect(within(cell("overview.agentsActive")).getByText("1")).toBeTruthy();
    expect(within(cell("overview.tasks")).getByText("3")).toBeTruthy();
    expect(within(cell("overview.blocked")).getByText("1")).toBeTruthy();
  });

  it("does not report a running count when the read model has none", async () => {
    const language = await show(undefined);
    const summary = screen.getByRole("region", { name: language.t("overview.summary") });
    expect(within(summary).getAllByText("—")).toHaveLength(5);
    expect(within(summary).queryByText("0")).toBeNull();
  });
});

describe("overview progress", () => {
  it("counts only tasks that published a criteria record", () => {
    expect(verifiedChecks([task("a", "done", 3, 4), task("b", "in-progress", null, null)])).toEqual({ verified: 3, total: 4 });
    expect(verifiedChecks([task("a", "pending", null, null)])).toBeNull();
    expect(verifiedChecks([])).toBeNull();
  });

  it("says so instead of drawing a bar when no criteria are published", async () => {
    const language = await show(read({ tasks: [task("T-101", "pending", null, null)] }));
    const progress = screen.getByRole("region", { name: language.t("overview.progress") });
    expect(within(progress).getByText(language.t("overview.verifiedUnknown"))).toBeTruthy();
    expect(within(progress).queryByRole("img")).toBeNull();
    expect(within(progress).queryByText("0 of 0 acceptance checks verified")).toBeNull();
  });

  it("shows verified checks and the four stage groups", async () => {
    const language = await show(read({ tasks: [task("T-101", "done", 2, 2), task("T-102", "in-progress", 4, 8)] }));
    const progress = screen.getByRole("region", { name: language.t("overview.progress") });
    expect(within(progress).getByText("6 of 10 acceptance checks verified")).toBeTruthy();
    const groups = progress.querySelectorAll("[data-stage-group]");
    expect([...groups].map(group => group.getAttribute("data-state"))).toEqual(["complete", "active", "pending", "pending"]);
  });

  it("reports an unavailable stage group as unavailable, not complete", () => {
    const partial = { current: null, stages: [{ stage: "setup-checks" as const, state: "complete" as const, evidence: "run" }] };
    expect(stageGroupState(partial, ["setup-checks", "plan-approved"])).toBe("unavailable");
    expect(stageGroupState(undefined, ["execution"])).toBe("unavailable");
  });
});

describe("overview run details", () => {
  it.each(["en", "zh-CN"] as const)("keeps all seven stages and binding limits in a collapsed disclosure (%s)", async locale => {
    const value = read();
    const language = await show(value, locale);
    const details = screen.getByText(language.t("overview.runDetails")).closest("details")!;
    expect(details).toBeTruthy();
    expect(details.hasAttribute("open")).toBe(false);
    fireEvent.click(within(details).getByText(language.t("overview.runDetails")));
    expect(details.hasAttribute("open")).toBe(true);
    expect([...details.querySelectorAll("[data-run-stage]")].map(row => [row.getAttribute("data-run-stage"), row.getAttribute("data-state")]))
      .toEqual(value.workflow.stages.map(item => [item.stage, item.state]));
    expect(within(details).getByText(run.binding.planRef)).toBeTruthy();
    expect(within(details).getByText(run.bindingDigest)).toBeTruthy();
    expect(within(details).getByText(language.t(`status.run.${run.state}`))).toBeTruthy();
    const fact = (key: string) => within(details).getByText(language.t(key as "overview.sessionLimit")).parentElement!.querySelector("dd")!.textContent;
    expect(fact("overview.sessionLimit")).toBe("3");
    expect(fact("overview.activeLimit")).toBe("60 s");
    expect(fact("overview.retryLimit")).toBe("0 / 1");
    expect(fact("overview.reviewLimit")).toBe("0 / 2");
  });

  it("marks missing stage evidence unavailable and missing limits unknown", async () => {
    const language = await show(undefined);
    const details = screen.getByText(language.t("overview.runDetails")).closest("details")!;
    expect(details.querySelectorAll('[data-run-stage][data-state="unavailable"]')).toHaveLength(7);
    expect(within(details).getAllByText("\u2014")).toHaveLength(7);
  });
});

describe("overview panels", () => {
  it("lists active tasks with a dash for the title the read model does not publish", async () => {
    const language = await show(read({ tasks: [task("T-101", "done", 2, 2), task("T-104", "blocked", null, null)] }));
    const table = screen.getByRole("region", { name: language.t("overview.activeTasks") });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map(row => row.getAttribute("data-task-id"))).toEqual(["T-101", "T-104"]);
    expect(within(rows[0]!).getByText("2/2")).toBeTruthy();
    expect(within(rows[1]!).getAllByText("—").length).toBeGreaterThan(0);
    expect(within(rows[1]!).queryByText("0")).toBeNull();
  });

  it.each(["en", "zh-CN"] as const)("links pending approvals to Reviews and keeps blocked tasks visible (%s)", async locale => {
    const value = read({ tasks: [task("T-104", "blocked", null, null)], approvals: [{
      id: "A-1", runId: run.id, kind: "orchestrator", action: "scope-change", payload: { reason: "API contract expanded" },
      payloadDigest: "p", targetDigest: "t", bindingDigest: "b", state: "pending", entityVersion: 1,
      expiresAt: "2026-11-01T00:00:00.000Z", decisionActor: null, awaitingDecision: true }] });
    const onOpenReviews = vi.fn();
    const language = await show(value, locale, onOpenReviews);
    const attention = screen.getByRole("region", { name: language.t("overview.needsAttention") });
    expect(attention.querySelectorAll("[data-attention]")).toHaveLength(2);
    fireEvent.click(within(attention).getByRole("button", { name: language.t("overview.viewReviews") }));
    expect(onOpenReviews).toHaveBeenCalledTimes(1);
    expect(attention.querySelector('[data-attention="approval"]')?.textContent).toContain("API contract expanded");
    expect(attention.querySelector('[data-attention="blocked"]')?.textContent).toContain("T-104");
  });

  it("shows an empty attention queue as empty rather than as unknown", async () => {
    const language = await show(read());
    const attention = screen.getByRole("region", { name: language.t("overview.needsAttention") });
    expect(within(attention).getByText(language.t("overview.noAttention"))).toBeTruthy();
  });

  it("lists the fleet by role with the provider and observed attempt state", async () => {
    const value = read({ attempts: [
      attempt({ attemptId: "a1", taskId: "T-101", qitemId: "q", role: "lead", provider: "codex", state: "running" }),
      attempt({ attemptId: "a2" })] });
    const language = await show(value);
    const fleet = screen.getByRole("region", { name: language.t("overview.fleet") });
    expect([...fleet.querySelectorAll("[data-fleet-role]")].map(item => item.getAttribute("data-fleet-role"))).toEqual(["lead", "implementer"]);
    expect(within(fleet).getByText("claude")).toBeTruthy();
  });

  it("formats tokens and cost from published values only", () => {
    expect(compactTokens(undefined)).toBe("—");
    expect(observedCost(undefined)).toBe("—");
    expect(compactTokens({ ...run, usage: { ...run.usage, inputTokens: { value: 0, reason: null }, outputTokens: { value: 900, reason: null } } })).toBe("900");
    expect(observedCost({ ...run, usage: { ...run.usage, costUsd: { value: 0, reason: null } } })).toBe("$0.00");
  });
});
