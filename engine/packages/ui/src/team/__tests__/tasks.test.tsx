import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import type { TeamOwnerRead, TeamReviewView } from "@openrig/daemon/team-control";
import { TasksScreen, boardColumn, groupTasks } from "../tasks.js";

/**
 * Slice A — the Tasks board.
 *
 * The grouping is the screen's promise: a task appears in the column that matches what the run
 * publishes about it, and nothing else.
 */

vi.mock("../../hooks/useOwnerSession.js", async importOriginal => ({ ...(await importOriginal<object>()),
  useOwnerSession: () => ({ paired: false, request: vi.fn() }),
}));
vi.mock("../new-task.js", () => ({ NewTaskForm: () => null }));

function task(id: string, state: TeamReviewView["queueState"], role: TeamReviewView["role"] = "implementer"): TeamReviewView {
  return { taskId: id, qitemId: `q-${id}`, role, queueState: state, title: null, dependencies: [],
    criteria: { verified: null, total: null, source: null }, currentCandidateDigest: null,
    rounds: 0, openP0P1: 0, reviewAvailable: false, acceptance: null };
}

const read = { tasks: [
  task("T-101", "done"), task("T-102", "in-progress"), task("T-103", "pending", "reviewer"),
  task("T-104", "blocked"), task("T-105", "failed"), task("T-106", "pending"),
] } as Pick<TeamOwnerRead, "tasks"> as TeamOwnerRead;

async function show(locale: "en" | "zh-CN" = "en", query?: string) {
  const language = await createInterfaceI18n({ preference: { read: () => locale, write() {} } });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={cache}><I18nextProvider i18n={language.instance}>
    <TasksScreen read={read} runId="RUN-1" query={query} />
  </I18nextProvider></QueryClientProvider>);
  return language;
}

describe("tasks board grouping", () => {
  it("places each task in the column its queue state names", () => {
    expect(boardColumn(task("a", "pending"))).toBe("pending");
    expect(boardColumn(task("a", "in-progress"))).toBe("in-progress");
    expect(boardColumn(task("a", "pending", "reviewer"))).toBe("review");
    expect(boardColumn(task("a", "done"))).toBe("review");
    expect(boardColumn(task("a", "handed-off"))).toBe("review");
    expect(boardColumn(task("a", "blocked"))).toBe("blocked");
    expect(boardColumn(task("a", "failed"))).toBe("blocked");
    expect(boardColumn(task("a", "denied"))).toBe("blocked");
  });

  it("groups every task exactly once, in id order", () => {
    const groups = groupTasks(read.tasks);
    expect(Object.fromEntries(Object.entries(groups).map(([column, items]) => [column, items.map(item => item.taskId)]))).toEqual({
      pending: ["T-106"], "in-progress": ["T-102"], review: ["T-101", "T-103"], blocked: ["T-104", "T-105"],
    });
    expect(groupTasks(undefined)).toEqual({ pending: [], "in-progress": [], review: [], blocked: [] });
  });

  it.each(["en", "zh-CN"] as const)("renders four labelled columns with their counts (%s)", async locale => {
    const language = await show(locale);
    const board = document.querySelector(".ui-board")!;
    expect(board.className).toBe("ui-board");
    const columns = [...board.querySelectorAll("[data-column]")];
    expect(columns.map(column => column.getAttribute("data-column"))).toEqual(["pending", "in-progress", "review", "blocked"]);
    expect(columns.map(column => within(column as HTMLElement).getByRole("heading").textContent)).toEqual([
      `${language.t("tasks.column.pending")}1`, `${language.t("tasks.column.in-progress")}1`,
      `${language.t("tasks.column.review")}2`, `${language.t("tasks.column.blocked")}2`,
    ]);
  });

  it("shows each task's published title and dependencies, and an em dash when the row has none", async () => {
    const language = await createInterfaceI18n({ preference: { read: () => "en", write() {} } });
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const published = { tasks: [
      { ...task("T-201", "pending"), title: "Add the status filter", dependencies: ["T-101"] },
      { ...task("T-202", "pending"), title: null, dependencies: null },
      { ...task("T-203", "pending"), title: "Wire the gate", dependencies: [] },
    ] } as Pick<TeamOwnerRead, "tasks"> as TeamOwnerRead;
    render(<QueryClientProvider client={cache}><I18nextProvider i18n={language.instance}>
      <TasksScreen read={published} runId="RUN-1" />
    </I18nextProvider></QueryClientProvider>);
    const card = (id: string) => screen.getByRole("button", { name: new RegExp(id) });
    expect(card("T-201").textContent).toContain("Add the status filter");
    expect(card("T-201").textContent).toContain("T-101");
    // A row the read model could not read is an em dash; a recorded empty list says "None".
    expect(card("T-202").textContent).toContain("—");
    expect(card("T-203").textContent).toContain(language.t("tasks.noDependencies"));
  });

  it("opens the task detail for the selected card and shows an em dash for unpublished fields", async () => {
    const language = await show();
    expect(screen.queryByRole("region", { name: language.t("tasks.detail") })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: new RegExp("T-102") }));
    const detail = screen.getByRole("region", { name: language.t("tasks.detail") });
    expect(within(detail).getByRole("heading", { name: "T-102" })).toBeTruthy();
    expect(within(detail).getAllByText("—").length).toBeGreaterThan(0);
    expect(within(detail).queryByText("0/0")).toBeNull();
    fireEvent.click(within(detail).getByRole("button", { name: language.t("web.close") }));
    expect(screen.queryByRole("region", { name: language.t("tasks.detail") })).toBeNull();
  });

  it("switches to the list view and filters by the shell's search query", async () => {
    const language = await show("en", "T-10");
    const board = document.querySelector(".ui-board")!;
    expect(board.querySelectorAll("[data-task-id]")).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(language.t("tasks.list")) }));
    const list = screen.getByRole("region", { name: language.t("tasks.list") });
    expect(within(list).getAllByRole("row")).toHaveLength(7);
    expect(screen.getByRole("button", { name: new RegExp(language.t("tasks.board")) }).getAttribute("aria-pressed")).toBe("false");
  });
});
