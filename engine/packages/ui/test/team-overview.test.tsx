import React from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { TEAM_HEALTH_LIGHTS, TEAM_QUEUE_STATES, TEAM_WORKFLOW_STAGES, type TeamOwnerRead, type TeamReadModel, type TeamApproval, type TeamRun, type TeamSystemHealth } from "@openrig/daemon/team-control";
import { routeTree } from "../src/routes.js";
import { queryClient } from "../src/lib/query-client.js";
import { INTERFACE_LANGUAGE_KEY } from "../src/team/shell.js";

const run: TeamRun = {
  id: "RUN-001", rigId: "RIG-001", bindingDigest: "binding-001", state: "approved", stateReason: null,
  entityVersion: 3, activeMs: 0, accountedAt: null, retriesUsed: 0, reviewRoundsUsed: 0,
  usage: { activeMs: 0, inputTokens: { value: null, reason: "unavailable" }, outputTokens: { value: null, reason: "unavailable" }, costUsd: { value: null, reason: "unavailable" } },
  createdAt: "2026-10-26T00:00:00Z", updatedAt: "2026-10-26T00:00:00Z",
  binding: {
    artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
    planRef: "docs/plans/fixture.md", planDigest: "a".repeat(64), repository: { root: "/fixture", identity: "fixture/repository" },
    readPaths: ["src/"], writePaths: ["src/"], roles: ["lead", "implementer", "reviewer"], policyRevision: 1,
    policyFingerprint: "b".repeat(64), limits: { maxSessions: 3, maxActiveMs: 60_000, maxRetries: 1, maxReviewRounds: 2 },
  },
};
const approval: TeamApproval = {
  id: "APPROVAL-001", runId: run.id, kind: "native", action: "native-tool", payload: {}, payloadDigest: "payload-001",
  targetDigest: "target-001", bindingDigest: run.bindingDigest, state: "pending", entityVersion: 2,
  expiresAt: "2026-10-27T00:00:00Z", decisionActor: null,
};
let failure = 0;
let healthAge = 0;
let approvals: TeamApproval[];
let protocolVersion = "1.0";
let projection: TeamOwnerRead;
let replay: ReturnType<TeamReadModel["replay"]>;
let history: ReturnType<typeof createMemoryHistory>;
let fetcher: ReturnType<typeof vi.fn>;
function health(): TeamSystemHealth {
  const checkedAt = new Date(Date.now() - healthAge).toISOString();
  return { schema: "multi-agent-system-health/v1", protocolVersion: "1.0", checkedAt, timeoutMs: 5_000, overall: "unknown", latestAttempts: {},
    lights: Object.fromEntries(TEAM_HEALTH_LIGHTS.map(name => [name, { state: name === "database" ? "ok" : "unknown", checkedAt, evidenceRef: null, reason: null }])) as TeamSystemHealth["lights"],
  };
}
async function mount(path = "/team/overview?run=RUN-001") {
  history = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({ routeTree, history });
  render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { name: "Multi-Agent Engineering Team" });
}
async function pair() {
  fireEvent.change(screen.getByLabelText("One-time pairing code"), { target: { value: "fixture-pairing" } });
  fireEvent.click(screen.getByRole("button", { name: "Pair browser", exact: true }));
  await screen.findByText(run.binding.planRef);
}
beforeEach(() => {
  failure = 0; healthAge = 0; protocolVersion = "1.0"; approvals = [approval];
  projection = { schema: "multi-agent-team-read/v1", protocolVersion: "1.0", runId: run.id, generatedAt: new Date().toISOString(), run,
    workflow: { current: "setup-checks", stages: TEAM_WORKFLOW_STAGES.map(stage => ({ stage, state: "unavailable", evidence: "No durable evidence" })) },
    tasks: [], attempts: [], approvals: [], logs: [], replay: { retainedFrom: 1, latestSeq: 1000 } };
  replay = { events: [], window: projection.replay, gap: false };
  localStorage.clear(); localStorage.setItem(INTERFACE_LANGUAGE_KEY, "en"); queryClient.clear();
  fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/owner-session/exchange")) return new Response(JSON.stringify({ antiForgeryToken: "fixture-csrf" }));
    if (failure === 503) throw new TypeError("network unavailable");
    if (failure) return new Response(JSON.stringify({ code: failure === 401 ? "owner_session_required" : "control_not_found" }), { status: failure });
    if (url.endsWith("/owner-session") && init?.method === "DELETE") return new Response(JSON.stringify({ revoked: true }));
    if (url.endsWith("/health")) return new Response(JSON.stringify({ protocolVersion, health: health() }));
    if (url.endsWith("/read")) return new Response(JSON.stringify({ protocolVersion, read: { ...projection, approvals: approvals.map(item => ({ ...item, awaitingDecision: item.state === "pending" })) } }));
    if (url.includes("/replay?")) return new Response(JSON.stringify({ protocolVersion, runId: run.id, ...replay }));
    if (url.endsWith("/approvals")) return new Response(JSON.stringify({ protocolVersion, approvals }));
    if (url.endsWith("/runs/RUN-001")) return new Response(JSON.stringify({ protocolVersion, run }));
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { history?.destroy(); queryClient.clear(); vi.unstubAllGlobals(); });

describe("managed overview on landed owner reads", () => {
  it("excludes the server-backed entrypoint from managed browser runtime imports", () => {
    for (const file of ["hooks/useOwnerSession.ts", "hooks/useTeamRun.ts", "team/run-stepper.tsx", "team/system-status.tsx", "team/task-list.tsx"]) {
      const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src", file), "utf8");
      expect(source).not.toMatch(/^import (?!type\b).*from "@openrig\/daemon\/team-control";$/m);
    }
  });
  it("renders every reference region, only calls managed reads, and never persists credentials", async () => {
    await mount();
    expect(fetcher).not.toHaveBeenCalled();
    await pair();
    for (const name of ["Current plan", "Run stages", "Task list", "Task detail", "Pending decisions", "Agent status", "System status", "Recent activity", "Evidence panel", "Usage"]) {
      expect(screen.getByRole("region", { name })).toBeTruthy();
    }
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).toMatch(/^\/api\/team-control\//);
      expect(init?.credentials).toBe("same-origin");
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      if (!url.endsWith("/exchange")) expect(new Headers(init?.headers).get("X-Multi-Agent-CSRF")).toBe("fixture-csrf");
    }
    expect(localStorage.length).toBe(1);
    expect(document.body.textContent).not.toContain("fixture-csrf");
    expect(document.querySelector("textarea")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve", exact: true })).toBeNull();
  });
  it("keeps all queue states, filters and language without fabricating progress or stage completion", async () => {
    await mount(); await pair();
    const taskList = screen.getByRole("region", { name: "Task list" });
    expect(within(taskList).getAllByRole("button")).toHaveLength(TEAM_QUEUE_STATES.length + 1);
    fireEvent.click(within(taskList).getByRole("button", { name: "Failed", exact: true }));
    fireEvent.change(screen.getByLabelText("Search tasks"), { target: { value: "task-kept" } });
    fireEvent.change(screen.getByLabelText("Interface language"), { target: { value: "zh-CN" } });
    await screen.findByRole("heading", { name: "多智能体工程团队" });
    expect((screen.getByLabelText("搜索任务") as HTMLInputElement).value).toBe("task-kept");
    expect(within(screen.getByRole("region", { name: "任务列表" })).getByRole("button", { name: "失败", exact: true }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getAllByText("不可用").length).toBeGreaterThan(3);
    expect(screen.getByText("交付决定")).toBeTruthy();
    expect(document.querySelector("[aria-current='step']")?.getAttribute("data-state")).toBe("unavailable");
    expect(document.querySelector("[role='progressbar']")).toBeNull();
    expect(screen.queryByText("100%")).toBeNull();
  });
  it("renders unavailable usage as unknown, never zero, and keeps unknown health out of OK styling", async () => {
    await mount(); await pair();
    const usage = screen.getByRole("region", { name: "Usage" });
    expect(within(usage).getAllByText("Unknown")).toHaveLength(3);
    expect(within(usage).queryByText("0")).toBeNull();
    await waitFor(() => expect(document.querySelector('[data-health-light="database"] .team-health-ok')).toBeTruthy());
    expect(document.querySelectorAll('[data-health-light] .team-health-unknown')).toHaveLength(5);
  });
  it("does not repaint old health evidence as current when the HTTP read succeeds", async () => {
    healthAge = 6_000; await mount(); await pair();
    expect(document.querySelectorAll('[data-health-light] .team-health-ok')).toHaveLength(0);
    expect(document.querySelectorAll('[data-health-light] .team-health-unknown')).toHaveLength(6);
  });
  it("preserves run, filters, selected tabs and pane scroll through expiry and re-pairing", async () => {
    await mount(); await pair();
    fireEvent.change(screen.getByLabelText("Search tasks"), { target: { value: "keep-filter" } });
    fireEvent.mouseDown(within(screen.getByRole("region", { name: "Task detail" })).getByRole("tab", { name: "Tests", exact: true }), { button: 0, ctrlKey: false });
    const monitoring = document.querySelector(".team-monitoring") as HTMLElement;
    monitoring.scrollTop = 180; fireEvent.scroll(monitoring);
    failure = 401;
    await act(async () => { await queryClient.refetchQueries({ queryKey: ["team"] }); });
    await screen.findByLabelText("One-time pairing code");
    expect((screen.getByLabelText("Search tasks") as HTMLInputElement).value).toBe("keep-filter");
    expect((screen.getByLabelText("Run ID") as HTMLInputElement).value).toBe("RUN-001");
    expect(document.querySelector('[data-health-light] .team-health-ok')).toBeNull();
    failure = 0; await pair();
    expect((screen.getByLabelText("Search tasks") as HTMLInputElement).value).toBe("keep-filter");
    expect(within(screen.getByRole("region", { name: "Task detail" })).getByRole("tab", { name: "Tests", exact: true }).getAttribute("aria-selected")).toBe("true");
    expect((document.querySelector(".team-monitoring") as HTMLElement).scrollTop).toBe(180);
  });
  it("marks disconnected reads and never enables a native decision or terminal input", async () => {
    await mount(); await pair(); failure = 503;
    await act(async () => { await queryClient.refetchQueries({ queryKey: ["team"] }); });
    await screen.findByText("Daemon unreachable");
    expect(document.querySelector('[data-health-light] .team-health-ok')).toBeNull();
    expect(screen.getByRole("tab", { name: "Owner terminal" }).hasAttribute("disabled")).toBe(true);
    for (const button of screen.getAllByRole("button", { name: "Open session" })) expect(button.hasAttribute("disabled")).toBe(true);
  });
  it("distinguishes a successful empty approval list from unknown approvals", async () => {
    approvals = []; await mount(); await pair();
    expect(screen.getByText("No pending decisions")).toBeTruthy();
  });
  it("does not guess an active run or send an empty run ID", async () => {
    await mount("/team");
    expect(screen.getByText("No run selected")).toBeTruthy();
    expect(screen.getByText(/Run discovery is unavailable/)).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects an incompatible response version rather than rendering success", async () => {
    protocolVersion = "2.0"; await mount();
    fireEvent.change(screen.getByLabelText("One-time pairing code"), { target: { value: "fixture-pairing" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair browser", exact: true }));
    await waitFor(() => expect(queryClient.getQueryState(["team", "RUN-001", "read"])?.status).toBe("error"));
    expect(screen.queryByText(run.binding.planRef)).toBeNull();
    expect(document.querySelector('[data-health-light] .team-health-ok')).toBeNull();
  });
  it("does not report approvals from a stale owner snapshot as current", async () => {
    await mount(); await pair();
    await act(async () => { queryClient.setQueryData(["team", "RUN-001", "read"], { ...projection, approvals, generatedAt: new Date(Date.now() - 6_000).toISOString() }, { updatedAt: Date.now() - 6_000 }); });
    const decisions = screen.getByRole("region", { name: "Pending decisions" });
    await waitFor(() => expect(within(decisions).getByText("Unknown")).toBeTruthy());
    expect(within(decisions).queryByText("APPROVAL-001")).toBeNull();
  });
  it("requires the version on managed read responses", async () => {
    protocolVersion = undefined as unknown as string;
    await mount();
    fireEvent.change(screen.getByLabelText("One-time pairing code"), { target: { value: "fixture-pairing" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair browser", exact: true }));
    await screen.findByText("Read failed");
    expect(screen.queryByText(run.binding.planRef)).toBeNull();
  });
  it("keeps filters, selected tabs, pane scroll and run identity across managed destinations", async () => {
    await mount(); await pair();
    fireEvent.change(screen.getByLabelText("Search tasks"), { target: { value: "across-tabs" } });
    fireEvent.mouseDown(within(screen.getByRole("region", { name: "Task detail" })).getByRole("tab", { name: "Tests", exact: true }), { button: 0, ctrlKey: false });
    fireEvent.mouseDown(within(screen.getByRole("region", { name: "Evidence panel" })).getByRole("tab", { name: "Review conversation" }), { button: 0, ctrlKey: false });
    const monitoring = document.querySelector(".team-monitoring") as HTMLElement;
    monitoring.scrollTop = 180; fireEvent.scroll(monitoring);
    fireEvent.click(within(document.querySelector(".team-nav") as HTMLElement).getByRole("link", { name: "Agent monitor" }));
    await waitFor(() => expect(history.location.pathname).toBe("/team/agents"));
    fireEvent.click(within(document.querySelector(".team-nav") as HTMLElement).getByRole("link", { name: "Task management" }));
    await screen.findByLabelText("Search tasks");
    expect((screen.getByLabelText("Search tasks") as HTMLInputElement).value).toBe("across-tabs");
    expect(history.location.search).toContain("run=RUN-001");
    expect.soft(within(screen.getByRole("region", { name: "Task detail" })).getByRole("tab", { name: "Tests", exact: true }).getAttribute("aria-selected")).toBe("true");
    expect.soft(within(screen.getByRole("region", { name: "Evidence panel" })).getByRole("tab", { name: "Review conversation" }).getAttribute("aria-selected")).toBe("true");
    expect.soft((document.querySelector(".team-monitoring") as HTMLElement).scrollTop).toBe(180);
  });
  it("consumes the shared snapshot without converting agent claims into verified progress", async () => {
    projection.tasks = [{ taskId: "TASK-003", qitemId: "QUEUE-003", role: "implementer", queueState: "done",
      criteria: { verified: 3, total: 4, source: "team_queue_authority.evidence_json" }, currentCandidateDigest: "candidate-003",
      rounds: 1, openP0P1: 0, reviewAvailable: true,
      acceptance: { manifestDigest: "candidate-003", passed: false, reason: "One criterion is unverified", recordedAt: run.updatedAt } }];
    projection.attempts = [{ attemptId: "ATTEMPT-003", runId: run.id, taskId: "TASK-003", qitemId: "QUEUE-003", role: "implementer",
      provider: "codex", state: "stopped", unknownReason: null, session: "session-003" }];
    projection.logs = [{ source: "task-outcome", streamItemId: null, ts: run.updatedAt, runId: run.id, taskId: "TASK-003",
      attemptId: "ATTEMPT-003", session: "session-003", body: "Agent claims 100% <script>throw 1</script> [REDACTED]", truncated: true, exitOutcome: "done" }];
    projection.workflow = { current: "integration-verification", stages: TEAM_WORKFLOW_STAGES.map(stage => ({ stage,
      state: stage === "integration-verification" ? "active" : stage === "delivery-decision" ? "pending" : "complete", evidence: "durable evidence" })) };
    await mount(); await pair();
    const tasks = screen.getByRole("region", { name: "Task list" });
    expect(within(tasks).getByText("3/4")).toBeTruthy();
    expect(within(tasks).queryByText("4/4")).toBeNull();
    expect(screen.getByRole("region", { name: "Agent status" }).textContent).toContain("session-003");
    const evidence = screen.getByRole("region", { name: "Evidence panel" });
    expect(evidence.textContent).toContain("[REDACTED]");
    expect(evidence.textContent).toContain("Truncated");
    expect(evidence.querySelector("script")).toBeNull();
    expect(document.querySelector("[aria-current='step']")?.textContent).toContain("Integration verification");
    expect((screen.getByRole("option", { name: "Priority" }) as HTMLOptionElement).disabled).toBe(true);
    fireEvent.click(within(tasks).getByRole("button", { name: "Failed", exact: true }));
    expect(within(tasks).queryByText("TASK-003")).toBeNull();
    fireEvent.change(screen.getByLabelText("Interface language"), { target: { value: "zh-CN" } });
    await screen.findByRole("heading", { name: "多智能体工程团队" });
    expect(screen.getByRole("region", { name: "智能体状态" }).textContent).toContain("session-003");
    expect(fetcher.mock.calls.some(([url]) => url.endsWith("/read"))).toBe(true);
    expect(fetcher.mock.calls.some(([url]) => url.endsWith("/runs/RUN-001") || url.endsWith("/approvals"))).toBe(false);
  });
  it("replays from the snapshot cursor, deduplicates events, reports gaps and refreshes durable state", async () => {
    await mount(); await pair();
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes("/replay?afterSeq=1000"))).toBe(true));
    replay = { events: [{ seq: 1001, createdAt: run.updatedAt, type: "team.control", action: "review.acceptance", runId: run.id,
      taskId: "TASK-003", attemptId: null, body: "persisted event [REDACTED]", truncated: true }], window: { retainedFrom: 1001, latestSeq: 1001 }, gap: true };
    projection.workflow = { current: "delivery-decision", stages: TEAM_WORKFLOW_STAGES.map(stage => ({ stage,
      state: stage === "delivery-decision" ? "awaiting-decision" : "complete", evidence: "durable evidence" })) };
    await act(async () => { await queryClient.refetchQueries({ queryKey: ["team", run.id, "events"] }); });
    const activity = screen.getByRole("region", { name: "Recent activity" });
    await waitFor(() => expect(within(activity).getByText("Replay gap")).toBeTruthy());
    await waitFor(() => expect(document.querySelector("[aria-current='step']")?.getAttribute("data-state")).toBe("awaiting-decision"));
    await act(async () => { await queryClient.refetchQueries({ queryKey: ["team", run.id, "events"] }); });
    expect(within(activity).getAllByText("persisted event [REDACTED]")).toHaveLength(1);
    expect(fetcher.mock.calls.some(([url]) => url.includes("/replay?afterSeq=1001"))).toBe(true);
  });

});
