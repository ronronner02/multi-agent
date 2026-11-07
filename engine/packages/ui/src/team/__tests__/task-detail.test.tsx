import React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { createInterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import { TaskScreen } from "../task-screen.js";
import { attempt, read, RUN_ID, seats, task } from "./fixtures.js";

const PATCH = [
  "diff --git a/src/filter.ts b/src/filter.ts",
  "--- a/src/filter.ts",
  "+++ b/src/filter.ts",
  "@@ -1,3 +1,4 @@",
  " export function filterItems(items) {",
  "-  return items.filter(Boolean);",
  "+  // The predicate decides.",
  "+  return items.filter(Boolean);",
  " }",
].join("\n");

vi.mock("../../hooks/useOwnerSession.js", () => ({
  OwnerReadError: class OwnerReadError extends Error {
    constructor(readonly status: number, readonly code: string) { super(code); }
  },
  useOwnerSession: () => ({
    paired: true,
    request: vi.fn(async (path: string) => path.endsWith("/result")
      ? { result: { patch: PATCH } }
      : {}),
    pair: vi.fn(), revoke: vi.fn(), openTerminal: vi.fn(), terminalAvailable: false,
  }),
  OwnerSessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

async function show(ui: React.ReactElement, locale: "en" | "zh-CN" = "en") {
  const language = await createInterfaceI18n({ language: locale });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><I18nextProvider i18n={language.instance}>{ui}</I18nextProvider></QueryClientProvider>);
}

describe("task detail", () => {
  it("shows the diff, the review round and the attempt, by name only", async () => {
    const verdicts = [{ round: 1, reviewerTaskId: "task-1-review-1", verdict: "approved" as const,
      candidateDigest: null, findings: 2, findingRecords: [
        { id: "note-1", severity: "P2" as const, file: "src/filter.ts", summary: "Clarify the predicate." },
        { id: "note-2", severity: "P3" as const, file: "src/filter.ts", summary: "Clarify the label." },
      ], blocking: 0, recordedAt: "2026-10-31T00:00:00.000Z" }];
    await show(<TaskScreen read={read({ tasks: [task({ verdicts })], attempts: [attempt()] })} runId={RUN_ID} taskId="task-1" seats={seats} onBack={() => {}} />);

    expect(screen.getByRole("heading", { name: "Status filter" })).toBeTruthy();
    expect(await screen.findByText(/filterItems/)).toBeTruthy();
    expect(await screen.findByText("Approved")).toBeTruthy();
    expect(await screen.findByText("2 findings")).toBeTruthy();
    expect(await screen.findByText("Attempt 1")).toBeTruthy();

    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
    expect(text).not.toMatch(/task-\d+/);
  });

  it("shows a failed attempt as a word, not a classifier code", async () => {
    const failure = { reasonCode: "native_exit_nonzero", resumeSafe: true, retryEligible: true, ownerAction: "Retry when ready." };
    await show(<TaskScreen read={read({ attempts: [attempt({ failure })] })} runId={RUN_ID} taskId="task-1" seats={seats} onBack={() => {}} />);
    expect(await screen.findByText("Failed")).toBeTruthy();
    expect(document.body.textContent ?? "").not.toContain("native_exit_nonzero");
  });

  it("says a review has not happened instead of drawing an empty verdict", async () => {
    await show(<TaskScreen read={read({ tasks: [task({ verdicts: [], reviewAvailable: false })] })} runId={RUN_ID} taskId="task-1" seats={seats} onBack={() => {}} />);
    expect(await screen.findByText("No review yet")).toBeTruthy();
  });
});