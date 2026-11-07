import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import type { TeamReviewView } from "@openrig/daemon/team-control";
import { reviewGates, ReviewsScreen } from "../reviews.js";
import type { IntegrationState } from "../clients.js";
import { read, RUN_ID, task } from "./fixtures.js";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../hooks/useOwnerSession.js", () => ({ useOwnerSession: () => ({ paired: true, request }) }));
const clients: QueryClient[] = [];
const digest = "sha256:" + "c".repeat(64);
const verdict: TeamReviewView["verdicts"][number] = {
  round: 1, reviewerTaskId: "private-review-task", verdict: "approved", candidateDigest: digest,
  findings: 0, findingRecords: [], blocking: 0, recordedAt: "2026-11-07T10:00:00.000Z",
};
const integration: IntegrationState = { available: true, branch: "team/status-filter",
  commits: [{ hash: "a".repeat(40), subject: "Add status filter", task: "task-1" }],
  tasksDone: true, merge: { possible: true, reason: null } };
const patch = "diff --git a/src/filter.ts b/src/filter.ts\n--- a/src/filter.ts\n+++ b/src/filter.ts\n@@ -1 +1 @@\n-oldFilter\n+newFilter\n";
const result = { schema: "multi-agent-team-result/v1", runId: RUN_ID, taskId: "task-1", manifestDigest: digest, patch };
beforeEach(() => request.mockReset().mockResolvedValue({ result }));
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });
async function show(candidate?: TeamReviewView) {
  const language = await createInterfaceI18n({ language: "en" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  const onAskLead = vi.fn(), onSelect = vi.fn();
  const tree = (next?: TeamReviewView) => <QueryClientProvider client={client}><I18nextProvider i18n={language.instance}>
    <ReviewsScreen read={read({ tasks: next ? [next] : [] })} selectedTaskId="" integration={integration} onAskLead={onAskLead} onSelect={onSelect} />
  </I18nextProvider></QueryClientProvider>;
  const view = render(tree(candidate));
  return { ...view, onAskLead, update: (next: TeamReviewView) => view.rerender(tree(next)) };
}
const complete = () => task({ criteria: { verified: 2, total: 2, source: "task-evidence.json" }, verdicts: [verdict] });

describe("read-only Reviews", () => {
  it("renders the candidate diff, finding records and all four gates", async () => {
    const candidate = complete();
    candidate.verdicts = [{ ...verdict, verdict: "changes-required", findings: 1, blocking: 1,
      findingRecords: [{ id: "private-finding-id", severity: "P1", file: "src/filter.ts", summary: "An empty selection hides every result." }] }];
    const { onAskLead } = await show(candidate);
    expect(await screen.findByText("newFilter")).toBeTruthy();
    const findings = screen.getByRole("region", { name: "Structured findings" });
    expect(within(findings).getByText("P1")).toBeTruthy();
    expect(within(findings).getByText("An empty selection hides every result.")).toBeTruthy();
    expect(findings.querySelector(".ui-count")?.textContent).toBe("1");
    expect(findings.querySelector("details")?.open).toBe(false);
    const gates = screen.getByRole("region", { name: "Gates" });
    expect(within(gates).getAllByRole("listitem")).toHaveLength(4);
    expect(gates.querySelector('[data-gate="evidence"]')?.getAttribute("data-state")).toBe("passed");
    expect(gates.querySelector('[data-gate="review"]')?.getAttribute("data-state")).toBe("waiting");
    const ask = screen.getByRole("button", { name: "Ask the lead" }); fireEvent.click(ask);
    expect(onAskLead).toHaveBeenCalledWith(candidate, ask);
    expect(screen.queryByRole("button", { name: /Approve candidate|Request changes|Merge changes/ })).toBeNull();
    expect(request.mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
  });

  it("passes only current candidate evidence and the existing integration and merge checks", () => {
    expect(reviewGates(complete(), integration).every(gate => gate.state === "passed")).toBe(true);
    const stale = complete(); stale.currentCandidateDigest = "sha256:" + "d".repeat(64);
    expect(reviewGates(stale, integration).filter(gate => gate.key !== "evidence").every(gate => gate.state === "waiting")).toBe(true);
    stale.currentCandidateDigest = null; stale.verdicts = [{ ...verdict, candidateDigest: null }];
    expect(reviewGates(stale, integration).find(gate => gate.key === "review")?.state).toBe("waiting");
    expect(reviewGates(task(), undefined).every(gate => gate.state === "unknown")).toBe(true);
    expect(reviewGates(complete(), { ...integration, commits: [] }).find(gate => gate.key === "integration")?.state).toBe("waiting");
    expect(reviewGates(complete(), { ...integration, merge: { possible: false, reason: "Owner checkout changed" } }).at(-1)?.state).toBe("waiting");
  });

  it.each([undefined, task({ currentCandidateDigest: null }), task({ queueState: "in-progress" })])("does not fetch an absent or unfinished candidate", async candidate => {
    await show(candidate);
    expect(request).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("fetches a new digest after rework and rejects a stale result response", async () => {
    const { update } = await show(complete());
    expect(await screen.findByText("newFilter")).toBeTruthy();
    update(task({ currentCandidateDigest: "sha256:" + "d".repeat(64) }));
    await screen.findByRole("alert");
    expect(screen.queryByText("newFilter")).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("labels historical findings as belonging to an earlier candidate", async () => {
    await show(task({ currentCandidateDigest: "sha256:" + "d".repeat(64), verdicts: [verdict] }));
    await waitFor(() => expect(screen.getByText("This review belongs to an earlier candidate.")).toBeTruthy());
  });
});
