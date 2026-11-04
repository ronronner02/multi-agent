import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { createInterfaceI18n } from "@openrig/i18n";
import { CompletionPanel, type TaskCompletion } from "../completion.js";

// MVP — the Tasks screen's owner action. The daemon is faked at the owner-session seam; the
// panel is real, and what it shows is what the daemon reported. The action's whole point is that
// it invents no evidence: the button that records `done` follows the daemon's own `validated`.

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../hooks/useOwnerSession.js", async importOriginal => ({ ...(await importOriginal<object>()),
  useOwnerSession: () => ({ paired: true, request: mocks.request }),
}));

const evidence = { validated: true, manifestDigest: "sha256:" + "a".repeat(64), base: "commit" as const,
  baseIdentifier: "b".repeat(40), fileCount: 3, changedPaths: ["src/result.ts"], outsideAssignment: [], reasons: [] };

function completion(overrides: Partial<TaskCompletion> = {}): TaskCompletion {
  return { taskId: "task", role: "implementer", subjectTaskId: "task", queueState: "in-progress",
    taskVersion: 2, actorSession: "builder@rig", attempt: { attemptId: "attempt-1", entityVersion: 1, state: "stopped", observed: true },
    openAttempts: 0, blockedReason: null, findingsRequired: false, evidence, ...overrides };
}

async function show(value: TaskCompletion) {
  mocks.request.mockImplementation(async (path: string) => path.endsWith("/completion")
    ? { completion: value } : { run: { entityVersion: 7 } });
  const language = await createInterfaceI18n({ preference: { read: () => "en", write() {} } });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={cache}><I18nextProvider i18n={language.instance}>
    <div className="team-shell"><CompletionPanel runId="run" taskId="task" /></div>
  </I18nextProvider></QueryClientProvider>);
  return language;
}

afterEach(() => { cleanup(); mocks.request.mockReset(); });

it("shows the observed attempt and the daemon's own evidence, and enables the decision it validates", async () => {
  const language = await show(completion());
  const panel = await screen.findByRole("region", { name: language.t("completion.title") });
  expect(await screen.findByText("attempt-1")).toBeTruthy();
  expect(panel.textContent).toContain(evidence.manifestDigest);
  expect(panel.textContent).toContain("src/result.ts");
  const done = screen.getByRole("button", { name: language.t("completion.markDone") }) as HTMLButtonElement;
  expect(done.disabled).toBe(false);
  expect((screen.getByRole("button", { name: language.t("completion.markFailed") }) as HTMLButtonElement).disabled).toBe(false);
  expect(mocks.request).toHaveBeenCalledWith("/runs/run/tasks/task/completion", expect.anything());
});

it("refuses to record done when the daemon did not validate the candidate, and says why", async () => {
  const language = await show(completion({ evidence: { ...evidence, validated: false,
    outsideAssignment: ["README.md"], reasons: ["1 changed path(s) fall outside the assignment"] } }));
  await screen.findByRole("region", { name: language.t("completion.title") });
  expect(await screen.findByText("1 changed path(s) fall outside the assignment")).toBeTruthy();
  expect((screen.getByRole("button", { name: language.t("completion.markDone") }) as HTMLButtonElement).disabled).toBe(true);
  // Recording the failure is still the owner's decision, so that action stays open.
  expect((screen.getByRole("button", { name: language.t("completion.markFailed") }) as HTMLButtonElement).disabled).toBe(false);
});

it("shows the daemon's blocked reason instead of offering an action that cannot be recorded", async () => {
  const language = await show(completion({ blockedReason: "The attempt has not been observed to stop",
    attempt: { attemptId: "attempt-1", entityVersion: 1, state: "running", observed: true } }));
  await screen.findByRole("region", { name: language.t("completion.title") });
  expect(await screen.findByText("The attempt has not been observed to stop")).toBeTruthy();
  expect((screen.getByRole("button", { name: language.t("completion.markDone") }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: language.t("completion.markFailed") }) as HTMLButtonElement).disabled).toBe(true);
});

it("treats a task that already has a terminal outcome as nothing left to record", async () => {
  const language = await show(completion({ queueState: "done" }));
  await screen.findByRole("region", { name: language.t("completion.title") });
  expect(await screen.findByText(language.t("completion.alreadyRecorded"))).toBeTruthy();
  expect(screen.queryByRole("button", { name: language.t("completion.markDone") })).toBeNull();
});
