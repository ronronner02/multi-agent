import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { createInterfaceI18n } from "@openrig/i18n";
import type { TeamOwnerRead, TeamRun } from "@openrig/daemon/team-control";
import { TasksScreen } from "../tasks.js";

const mocks = vi.hoisted(() => ({ request: vi.fn(), paired: true }));
vi.mock("../../hooks/useOwnerSession.js", async original => ({ ...(await original<object>()),
  useOwnerSession: () => ({ paired: mocks.paired, request: mocks.request }),
}));
vi.mock("../new-task.js", () => ({ NewTaskForm: () => null }));

let run: TeamRun;
beforeEach(() => {
  run = { id: "run", rigId: "rig", state: "approved", stateReason: null, entityVersion: 10,
    activeMs: 0, accountedAt: null, retriesUsed: 0, reviewRoundsUsed: 0, bindingDigest: "binding", createdAt: "", updatedAt: "",
    usage: { activeMs: 0, inputTokens: { value: null, reason: null }, outputTokens: { value: null, reason: null }, costUsd: { value: null, reason: null } },
    binding: { artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
      repository: { root: "/fixture", identity: "git:fixture" }, planRef: "plan.md", planDigest: "plan",
      roles: ["implementer"], readPaths: ["src/A.ts"], writePaths: ["src/A.ts"], policyRevision: 1, policyFingerprint: "policy",
      limits: { maxSessions: 1, maxActiveMs: 3600000, maxRetries: 1, maxReviewRounds: 1 } } };
  mocks.request.mockImplementation(async (path, init) => {
    if (!init?.method && path === "/runs/run") return { run: structuredClone(run) };
    if (!init?.method && path === "/runs/run/tasks/A/edit") return { runVersion: 10, task: { taskVersion: 2 } };
    if (path === "/runs/run/tasks/A/edit") {
      run = { ...run, state: "invalidated", stateReason: "plan-change-required", entityVersion: 11 };
      return { status: "accepted", entityVersion: 11, value: { classification: "plan-change-required" } };
    }
    if (path === "/runs/run/growth") return { status: "accepted", entityVersion: 12, value: { state: "pending" } };
    throw new Error("Unexpected route " + path);
  });
});
afterEach(() => { cleanup(); mocks.request.mockReset(); mocks.paired = true; });
async function show() {
  const language = await createInterfaceI18n({ preference: { read: () => "en", write() {} } });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const read: TeamOwnerRead = { schema: "multi-agent-team-read/v1", protocolVersion: "1.0", runId: run.id, run,
    generatedAt: new Date().toISOString(), workflow: { current: "execution", stages: [] },
    tasks: [{ taskId: "A", qitemId: "qA", role: "implementer", queueState: "pending", title: "Initial task", dependencies: [],
      criteria: { verified: null, total: null, source: null }, currentCandidateDigest: null,
      rounds: 0, openP0P1: 0, reviewAvailable: false, acceptance: null }],
    attempts: [], approvals: [], logs: [], replay: { retainedFrom: 1, latestSeq: 1 } };
  render(<QueryClientProvider client={cache}><I18nextProvider i18n={language.instance}>
    <TasksScreen read={read} runId="run" />
  </I18nextProvider></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: language.t("edit.addTask") }));
  await waitFor(() => expect(screen.getByLabelText(language.t("web.taskId")).hasAttribute("disabled")).toBe(false));
  fireEvent.change(screen.getByLabelText(language.t("web.taskId")), { target: { value: "B" } });
  fireEvent.change(screen.getByLabelText(language.t("web.session")), { target: { value: "seat-B" } });
  fireEvent.change(screen.getByLabelText(language.t("web.files")), { target: { value: "src/B.ts" } });
  fireEvent.change(screen.getByLabelText(language.t("web.goal")), { target: { value: "Implement B" } });
  return language.t;
}

it("suspends through task editing before requesting approval for the exact added task", async () => {
  const t = await show();
  fireEvent.click(screen.getByRole("button", { name: t("edit.submit") }));
  await screen.findByText(t("edit.plan-change-required"));
  expect(mocks.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  const edit = JSON.parse(mocks.request.mock.calls.find(([path, init]) => path.endsWith("/edit") && init?.method === "POST")![1].body);
  expect(edit).toMatchObject({ actionId: "A", expectedEntityVersion: 10, payload: { expectedTaskVersion: 2,
    changes: { addTask: { assignment: { taskId: "B", paths: ["src/B.ts"] }, destinationSession: "seat-B", body: "Implement B" } } } });
  await waitFor(() => expect(screen.getByRole("button", { name: t("edit.submit") }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: t("edit.submit") }));
  await screen.findByText(t("team.requested"));
  const growth = JSON.parse(mocks.request.mock.calls.find(([path]) => path.endsWith("/growth"))![1].body);
  expect(growth).toMatchObject({ expectedEntityVersion: 11, payload: { writePaths: ["src/A.ts", "src/B.ts"],
    tasks: [{ assignment: { taskId: "B", role: "implementer", paths: ["src/B.ts"], dependencies: [] }, body: "Implement B" }] } });
  expect(mocks.request.mock.calls.some(([path]) => path.endsWith("/approvals/decide"))).toBe(false);
  expect(screen.getByRole("link", { name: t("web.pendingDecisions") }).getAttribute("href")).toBe("/team/overview?run=run");
});

it("retains the exact growth request after a lost acknowledgement", async () => {
  run = { ...run, state: "invalidated", entityVersion: 11 };
  const original = mocks.request.getMockImplementation()!;
  let lost = true;
  mocks.request.mockImplementation(async (...args) => {
    if (args[0].endsWith("/growth") && lost) { lost = false; throw new TypeError("connection lost"); }
    return original(...args);
  });
  const t = await show();
  fireEvent.click(screen.getByRole("button", { name: t("edit.submit") }));
  fireEvent.click(await screen.findByRole("button", { name: t("edit.retryExact") }));
  await screen.findByText(t("team.requested"));
  const requests = mocks.request.mock.calls.filter(([path]) => path.endsWith("/growth"));
  expect(requests).toHaveLength(2); expect(requests[1]![1].body).toBe(requests[0]![1].body);
});
