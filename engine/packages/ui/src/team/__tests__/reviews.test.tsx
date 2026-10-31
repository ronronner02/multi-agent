import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import type { TeamOwnerRead } from "@openrig/daemon/team-control";
import { ReviewsScreen, reviewCandidate, reviewGates, taskDecision } from "../reviews.js";
import { read, run, task } from "./fixtures.js";

/**
 * Slice B — Reviews.
 *
 * The screen may not invent review evidence: no recorded round means "none recorded", an
 * unrecorded gate is unknown, and Approve and Request changes are the two outcomes of the task's
 * own pending approval — sent through the existing decide route, never synthesized here.
 */

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../hooks/useOwnerSession.js", async importOriginal => ({ ...(await importOriginal<object>()),
  useOwnerSession: () => ({ paired: true, request: mocks.request }),
}));

const PATCH = ["diff --git a/src/filter.test.ts b/src/filter.test.ts", "--- a/src/filter.test.ts", "+++ b/src/filter.test.ts",
  "@@ -38,3 +38,3 @@ describe('filter', () => {", "   const input = [", "-    { id: 1, state: 'invalid' },",
  "+    { id: 1, state: 'error' },", "     { id: 2, state: 'active' },", ""].join("\n");

function approval(overrides: Partial<TeamOwnerRead["approvals"][number]> = {}): TeamOwnerRead["approvals"][number] {
  return { id: "approval-1", runId: run.id, kind: "orchestrator", action: "merge", payload: { taskId: "T-102" },
    payloadDigest: "payload", targetDigest: "target", bindingDigest: "binding", state: "pending", entityVersion: 2,
    expiresAt: "2099-01-01T00:00:00.000Z", decisionActor: null, awaitingDecision: true, ...overrides };
}

async function show(value: TeamOwnerRead, locale: "en" | "zh-CN" = "en") {
  const language = await createInterfaceI18n({ preference: { read: () => locale, write() {} } });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.request.mockResolvedValue({ result: { schema: "multi-agent-team-result/v1", runId: run.id, taskId: "T-102",
    attemptId: null, repositoryRoot: "/repo", base: "commit", baseIdentifier: "a".repeat(40),
    manifestDigest: `sha256:${"c".repeat(64)}`, files: [], patch: PATCH } });
  render(<QueryClientProvider client={cache}><I18nextProvider i18n={language.instance}><div className="team-shell">
    <ReviewsScreen read={value} runId={run.id} available refresh={async () => {}} />
  </div></I18nextProvider></QueryClientProvider>);
  return language;
}

afterEach(() => { mocks.request.mockReset(); });

describe("review evidence", () => {
  it("reads the candidate from the task that holds one, and the decision from the task it names", () => {
    const other = task({ taskId: "T-101", qitemId: "q-T-101", currentCandidateDigest: null });
    const candidate = task();
    expect(reviewCandidate([other, candidate])?.taskId).toBe("T-102");
    expect(reviewCandidate([])).toBeUndefined();
    expect(taskDecision([approval()], candidate)?.id).toBe("approval-1");
    // A decision that names another task is not this task's decision.
    expect(taskDecision([approval({ payload: { taskId: "T-999" } })], candidate)).toBeUndefined();
  });

  it("marks a gate unknown when no evidence exists, never passed", () => {
    const unknown = reviewGates(task({ reviewAvailable: false }), []);
    expect(unknown.map(gate => [gate.key, gate.state])).toEqual([
      ["tests", "unknown"], ["review", "unknown"], ["integration", "unknown"], ["delivery", "unknown"]]);
    const reviewed = reviewGates(task(), []);
    expect(reviewed.find(gate => gate.key === "review")?.state).toBe("waiting");
    const accepted = reviewGates(task({ openP0P1: 0, acceptance: { manifestDigest: "d", passed: true, reason: "ok", recordedAt: "2026-10-31T00:00:00.000Z" } }),
      [approval({ state: "approved" })]);
    expect(accepted.map(gate => gate.state)).toEqual(["passed", "passed", "passed", "passed"]);
    const failedAcceptance = reviewGates(task({ acceptance: { manifestDigest: "d", passed: false, reason: "tests failed", recordedAt: "2026-10-31T00:00:00.000Z" } }), []);
    expect(failedAcceptance.find(gate => gate.key === "tests")).toMatchObject({ state: "waiting", detail: "tests failed" });
  });
});

describe("reviews screen", () => {
  it.each(["en", "zh-CN"] as const)("shows the candidate diff, the findings and the four gates (%s)", async locale => {
    const language = await show(read(), locale);
    expect(await screen.findByTestId("diff-view")).toBeTruthy();
    expect(document.querySelector(".ui-diff-files button")?.getAttribute("data-path")).toBe("src/filter.test.ts");
    expect(document.querySelectorAll(".ui-diff-line")).toHaveLength(4);
    expect(within(screen.getByRole("region", { name: language.t("reviews.findings") })).getByTestId("open-p0p1").textContent).toBe("1");
    const gates = within(screen.getByRole("region", { name: language.t("reviews.gates") })).getAllByRole("listitem");
    expect(gates.map(gate => gate.getAttribute("data-gate"))).toEqual(["tests", "review", "integration", "delivery"]);
    expect(gates[0]!.getAttribute("data-state")).toBe("unknown");
  });

  it("says no findings are recorded rather than drawing an empty clean pass", async () => {
    const language = await show(read({ tasks: [task({ reviewAvailable: false, rounds: 0 })] }));
    expect(await screen.findByTestId("no-findings")).toBeTruthy();
    expect(screen.getByTestId("no-findings").textContent).toBe(language.t("reviews.noFindings"));
    expect(screen.queryByTestId("open-p0p1")).toBeNull();
  });

  it("says the candidate is pending while the task is still running", async () => {
    const language = await show(read({ tasks: [task({ queueState: "in-progress" })] }));
    expect((await screen.findByTestId("review-pending")).textContent).toContain(language.t("reviews.candidatePendingTitle"));
    expect(screen.queryByTestId("diff-view")).toBeNull();
    // The route would refuse an unfinished task, so it is never asked.
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each([["reviews.approve", "approved"], ["reviews.requestChanges", "rejected"]] as const)(
    "sends %s through the approvals decide route", async (label, decision) => {
      const language = await createInterfaceI18n({ preference: { read: () => "en", write() {} } });
      mocks.request.mockImplementation(async (path: string) => path.endsWith("/result")
        ? { result: { schema: "multi-agent-team-result/v1", runId: run.id, taskId: "T-102", attemptId: null,
            repositoryRoot: "/repo", base: "commit", baseIdentifier: "a".repeat(40), manifestDigest: "m", files: [], patch: PATCH } }
        : { status: "accepted", runId: run.id, entityVersion: 4, replayed: false, effectMayStart: false, value: null, reason: null });
      const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const refresh = vi.fn(async () => {});
      render(<QueryClientProvider client={cache}><I18nextProvider i18n={language.instance}><div className="team-shell">
        <ReviewsScreen read={read({ approvals: [approval()] })} runId={run.id} available refresh={refresh} />
      </div></I18nextProvider></QueryClientProvider>);
      fireEvent.click(screen.getByRole("button", { name: language.t(label) }));
      const dialog = await screen.findByRole("dialog", { name: language.t(label) });
      expect(dialog.textContent).toContain(language.t("reviews.confirmDecision"));
      fireEvent.click(within(dialog).getByRole("button", { name: language.t("web.confirmDecision") }));
      await waitFor(() => expect(refresh).toHaveBeenCalled());
      const call = mocks.request.mock.calls.find(([path]) => path === `/runs/${run.id}/approvals/decide`);
      expect(call).toBeTruthy();
      expect(JSON.parse(call![1].body)).toMatchObject({
        protocolVersion: "1.0", runId: run.id, actionId: "approval-1", expectedEntityVersion: 3,
        payload: { approvalVersion: 2, decision },
      });
    });

  it("offers no decision buttons when the run asked for none", async () => {
    const language = await show(read());
    const panel = await screen.findByRole("region", { name: language.t("web.pendingDecisions") });
    expect(within(panel).getByText(language.t("web.noDecisions"))).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: language.t("reviews.approve") })).toBeNull();
    expect(within(panel).queryByRole("button", { name: language.t("reviews.requestChanges") })).toBeNull();
  });
});
