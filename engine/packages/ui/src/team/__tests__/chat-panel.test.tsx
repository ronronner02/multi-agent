import React, { useRef, useState } from "react";
import { act, cleanup, fireEvent, render as renderView, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInterfaceI18n } from "@multi-agent/i18n";
import { I18nextProvider } from "react-i18next";
import { ChatPanel, pendingOwnerDecisions } from "../chat-panel.js";
import { readChat, type ChatState } from "../clients.js";
import { attempt, read, RUN_ID } from "./fixtures.js";

const { request, workflowRead } = vi.hoisted(() => ({ request: vi.fn(), workflowRead: vi.fn() }));
vi.mock("../../hooks/useOwnerSession.js", () => ({ useOwnerSession: () => ({ paired: true,
  request: (path: string, init?: RequestInit) => path === "/workflows" || /^\/runs\/[^/]+\/workflows$/.test(path)
    ? workflowRead(path, init) : request(path, init),
}) }));
const chat: ChatState = { available: true, phase: "delivery", pendingDecision: null, messages: [] };
const planApproval = {
  plan: { content: "# Stock utilities\n\nBuild two independent modules.", hash: "plan-hash" },
  roster: { seats: [
    { role: "implementer" as const, client: "claude-code" as const },
    { role: "implementer" as const, client: "codex" as const },
    { role: "reviewer" as const, client: "claude-code" as const },
  ], digest: "reviewed-roster-digest" },
  error: null,
};
const planningRead = () => read({ run: { ...read().run, phase: "planning" }, seats: [read().seats[0]!] });
const planningChat = () => ({ ...chat, phase: "planning" as const, planApproval });
const documentChat = (confirmed = false): ChatState => ({ ...planningChat(),
  planApproval: { ...planApproval, documentVersions: confirmed ? {
    requirements: { versionId: "requirements-1", hash: "requirements-hash" }, plan: { versionId: "plan-2", hash: "plan-hash" },
  } : undefined },
  documentWorkflow: { stage: "plan", pendingStage: null, error: null, executionVersions: null, executionHistory: [],
    confirmed: { brainstorm: null, requirements: "requirements-1", plan: confirmed ? "plan-2" : null },
    versions: [{ id: "plan-2", kind: "plan", version: 2, path: "plan.md", content: "# Current plan", hash: "plan-hash",
      requirementsVersionId: "requirements-1", sourceAttemptId: "turn-2", createdAt: "2026-11-08T00:00:00.000Z", confirmedAt: null, confirmedBy: null }] },
});

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  request.mockReset().mockResolvedValue({});
  workflowRead.mockReset().mockResolvedValue({ workflows: [] });
});
afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); });

function render(ui: React.ReactElement) {
  return renderView(ui, { wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider> });
}

async function show(data = read(), conversation = chat, connectionError = false) {
  const language = await createInterfaceI18n({ language: "en" });
  function Harness({ conversation }: { conversation: ChatState }) {
    const [open, setOpen] = useState(false);
    const [section, setSection] = useState("Overview");
    const opener = useRef<HTMLButtonElement>(null);
    return <div>
      <button onClick={event => { opener.current = event.currentTarget; setOpen(true); }}>Coordinator</button>
      <button onClick={event => { opener.current = event.currentTarget; setOpen(true); }}>Top bar chat</button>
      <button onClick={() => setSection("Tasks")}>Navigate</button><h1>{section}</h1>
      <ChatPanel open={open} onOpenChange={setOpen} opener={opener} read={data} runId={RUN_ID} chat={conversation} connectionError={connectionError} />
    </div>;
  }
  const view = render(<I18nextProvider i18n={language.instance}><Harness conversation={conversation} /></I18nextProvider>);
  return { ...view, language, updateConversation: (next: ChatState) => view.rerender(
    <I18nextProvider i18n={language.instance}><Harness conversation={next} /></I18nextProvider>,
  ) };
}

describe("persistent lead chat", () => {
  it("uses the current interface language for typed chat after switching languages", async () => {
    const view = await show();
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    await act(async () => { await view.language.changeLanguage("zh-CN"); });
    const field = screen.getByRole("textbox");
    fireEvent.change(field, { target: { value: "Keep the original message text." } });
    fireEvent.submit(field.closest("form")!);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(JSON.parse(request.mock.calls[0]![1].body).payload).toEqual({
      body: "Keep the original message text.", responseLanguage: "zh-CN",
    });
  });

  it.each([true, false])("shows project-wide approval consequences only for that grant (%s)", async projectWide => {
    const data = planningRead();
    data.run.binding.readPaths = projectWide ? ["plan.md", "."] : ["plan.md", "src"];
    await show(data, documentChat(true));
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    const consequence = "This starts the displayed plan and team across this project's ordinary implementation files. " +
      "Protected paths, external actions, budget increases and final merge remain separate owner decisions.";
    expect(screen.queryAllByText(consequence)).toHaveLength(projectWide ? 1 : 0);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Approve execution" } });
    expect(screen.queryAllByText(consequence)).toHaveLength(projectWide ? 2 : 0);
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps expandable context and document tools from pushing the composer out of the viewport", async () => {
    const language = await createInterfaceI18n({ language: "en" });
    const onOpenDocuments = vi.fn();
    const displayName = "A long discussion about the project requirements. ".repeat(30).trim();
    render(<I18nextProvider i18n={language.instance}><ChatPanel open onOpenChange={() => {}}
      opener={{ current: null }} runId={RUN_ID} read={{ ...planningRead(), run: { ...planningRead().run, displayName } }}
      chat={documentChat(true)} onOpenDocuments={onOpenDocuments} /></I18nextProvider>);
    const dialog = screen.getByRole("dialog", { name: "Lead chat" });
    const header = dialog.querySelector("header")!;
    expect(within(header).getByRole("button", { name: "Show more" }).getAttribute("aria-expanded")).toBe("false");
    expect(header.querySelector(".ui-text-preview-body")?.textContent).toBe(displayName);
    expect(dialog.querySelector(".ui-document-stages")?.closest(".chat-log")).toBeTruthy();
    expect(dialog.querySelector(".composer")?.closest(".chat-log")).toBeNull();
    fireEvent.click(within(header).getByRole("button", { name: "Open documents and versions" }));
    expect(onOpenDocuments).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps the optional live output returned by the existing chat read", async () => {
    const liveTurn = { attemptId: "live-1", state: "running", progress: null, activity: null };
    request.mockResolvedValueOnce({ ...chat, liveTurn });
    expect(await readChat(request, RUN_ID)).toMatchObject({ liveTurn });
  });

  it("updates an actual response block in place, then replaces it with the saved reply and a question", async () => {
    const first = { ...planningChat(), liveTurn: { attemptId: "live-1", state: "running" as const, activity: null,
      progress: { sequence: 1, at: "2026-11-08T01:00:00Z", status: "responding" as const, truncated: false,
        blocks: [{ id: "text-1", text: "I will check", complete: false }] } } };
    const view = await show({ ...planningRead(), attempts: [attempt({ role: "lead", state: "running", attemptId: "live-1" })] }, first);
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    const current = screen.getByRole("region", { name: "Current reply" });
    const block = within(current).getByText("I will check");
    expect(within(current).getByRole("status").textContent).toBe("Replying…");
    view.updateConversation({ ...first, liveTurn: { ...first.liveTurn, progress: { ...first.liveTurn.progress, sequence: 2,
      blocks: [{ id: "text-1", text: "I will check the files.", complete: true }] } } });
    expect(within(current).getByText("I will check the files.")).toBe(block);
    const question = { id: "question-after-live", sender: "lead" as const, kind: "decision" as const, body: "Which output format?",
      options: ["Plain text", "JSON"], answeredBy: null, createdAt: "2026-11-08T01:01:00Z" };
    view.updateConversation({ ...first, liveTurn: null, messages: [
      { ...question, id: "reply", kind: "text", body: "I will check the files.", options: null }, question,
    ], pendingDecision: question });
    expect(screen.queryByRole("region", { name: "Current reply" })).toBeNull();
    expect(screen.getAllByText("I will check the files.")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Plain text" })).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["running", "stopped"] as const)("shows the observed %s state without inventing a thinking transcript", async state => {
    await show(planningRead(), { ...planningChat(), liveTurn: { attemptId: "live-1", state, activity: null,
      progress: { sequence: 1, at: "2026-11-08T01:00:00Z", status: "thinking", blocks: [], truncated: false } } });
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    const current = screen.getByRole("region", { name: "Current reply" });
    expect(within(current).getByRole("status").textContent).toBe(state === "running" ? "Thinking…" : "Turn ended");
    expect(current.getAttribute("aria-busy")).toBe(String(state === "running"));
    expect(current.querySelectorAll(".turn-body")).toHaveLength(0);
  });

  it("stops presenting stale progress as live after a connection error", async () => {
    await show(planningRead(), { ...planningChat(), liveTurn: { attemptId: "live-1", state: "running", activity: null,
      progress: { sequence: 1, at: "2026-11-08T01:00:00Z", status: "thinking", blocks: [], truncated: false } } }, true);
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    const current = screen.getByRole("region", { name: "Current reply" });
    expect(screen.getByRole("alert").textContent).toBe("Live updates interrupted. The last received output is retained.");
    expect(current.getAttribute("aria-busy")).toBe("false");
    expect(within(current).queryByText("Thinking…")).toBeNull();
    expect(current.querySelectorAll(".turn-body")).toHaveLength(0);
  });

  it("shows real tool state without duplicating a call's start and completion", async () => {
    const call = { id: "call-1", seq: 1, at: "2026-11-08T01:00:00Z", tool: "Read", summary: "src/greet.mjs", status: "running" as const };
    await show(planningRead(), { ...planningChat(), liveTurn: { attemptId: "live-1", state: "running", progress: null,
      activity: { attemptId: "live-1", state: "running", source: "live", startedAt: call.at, stoppedAt: null, activeMs: 2000,
        outcome: "unknown", activityStatus: "available", nextSeq: 2, records: [call, { ...call, seq: 2, status: "completed" }],
        usage: { status: "unavailable", model: null, reason: null, inputTokens: null, outputTokens: null, cacheReadInputTokens: null,
          cacheWriteInputTokens: null, reasoningOutputTokens: null } } } });
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    const current = screen.getByRole("region", { name: "Current reply" });
    fireEvent.click(within(current).getByText("Tool activity"));
    expect(current.querySelectorAll("[data-call]")).toHaveLength(1);
    expect(current.querySelector("[data-call]")?.getAttribute("data-status")).toBe("succeeded");
    expect(within(current).getByText("src/greet.mjs")).toBeTruthy();
  });

  it("presents a new question after the conversation without taking the owner's draft or focus", async () => {
    const owner = { id: "owner-1", sender: "owner" as const, kind: "text" as const, body: "Let's decide the input behavior.",
      options: null, answeredBy: null, createdAt: "2026-11-08T00:00:00Z" };
    const conversation = { ...documentChat(), messages: [owner] };
    const view = await show(planningRead(), conversation);
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    const field = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "My additional detail" } }); field.focus();
    const question = { ...owner, id: "question-next", sender: "lead" as const, kind: "decision" as const,
      body: "How should a missing name behave?", options: ["Return a default greeting", "Throw an error"] };
    view.updateConversation({ ...conversation, messages: [owner, question], pendingDecision: question });
    const history = screen.getByText(owner.body), decision = screen.getByRole("heading", { name: question.body });
    expect(history.compareDocumentPosition(decision) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(within(screen.getByRole("region", { name: "Needs your attention" })).getByRole("status").textContent)
      .toBe("A question is waiting for your answer.");
    expect(field.value).toBe("My additional detail"); expect(document.activeElement).toBe(field);
    fireEvent.click(screen.getByRole("button", { name: "Return a default greeting" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(JSON.parse(request.mock.calls[0]![1].body).payload).toEqual({ responseLanguage: "en", body: "Return a default greeting", answerTo: question.id });
    expect((screen.getByRole("button", { name: "Throw an error" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("wraps saved document hashes without changing the retained message text", async () => {
    const body = `Discuss version sha256:${"a".repeat(64)}`;
    await show(planningRead(), { ...planningChat(), messages: [{ id: "reference", sender: "owner", kind: "text", body,
      options: null, answeredBy: null, createdAt: "2026-11-08T00:00:00.000Z" }] });
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    const message = screen.getByText(body);
    expect(message.style.overflowWrap).toBe("anywhere");
    expect(message.textContent).toBe(body);
  });

  it("opens a project discussion before a run and starts planning only on send", async () => {
    const language = await createInterfaceI18n({ language: "en" });
    const onStarted = vi.fn();
    request.mockResolvedValue({ runId: "planning-record" });
    render(<I18nextProvider i18n={language.instance}><ChatPanel open onOpenChange={() => {}}
      opener={{ current: null }} runId="" project={{ id: "project-1", name: "My project" }} onStarted={onStarted} /></I18nextProvider>);
    expect(screen.getByRole("dialog", { name: "Lead chat" })).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
    const field = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(field, { target: { value: "Let's refine the scope first." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("planning-record"));
    expect(request).toHaveBeenCalledWith("/runs", expect.objectContaining({ method: "POST",
      body: JSON.stringify({ goal: "Let's refine the scope first.", responseLanguage: "en", rig: "project-1", planning: true, documentWorkflow: true }),
    }));
  });

  it("sends a selected delivery workflow as an explicit owner request without extra mutations", async () => {
    workflowRead.mockImplementation(async (path: string) => ({ workflows: path === "/workflows"
      ? [{ name: "spec-handoff", invocation: "user" }] : [] }));
    await show(); fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    await screen.findByRole("option", { name: "spec-handoff" });
    expect(request).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox", { name: "Workflow" }), { target: { value: "spec-handoff" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Read-only execution" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Summarize the current task." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(JSON.parse(request.mock.calls[0]![1].body).payload.body).toBe("/spec-handoff --read-only\nSummarize the current task.");
    expect(workflowRead).toHaveBeenCalledWith("/workflows", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(workflowRead).toHaveBeenCalledWith(`/runs/${RUN_ID}/workflows`, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("includes a selected workflow in the initial owner request while keeping plan approval separate", async () => {
    const language = await createInterfaceI18n({ language: "en" });
    const onStarted = vi.fn();
    request.mockResolvedValue({ runId: "planning-record" });
    workflowRead.mockResolvedValue({ workflows: [{ name: "spec-plan", invocation: "workflow" }] });
    render(<I18nextProvider i18n={language.instance}><ChatPanel open onOpenChange={() => {}}
      opener={{ current: null }} runId="" project={{ id: "project-1", name: "My project" }} onStarted={onStarted} /></I18nextProvider>);
    await screen.findByRole("option", { name: "spec-plan" });
    fireEvent.change(screen.getByRole("combobox", { name: "Workflow" }), { target: { value: "spec-plan" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Plan the next milestone." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("planning-record"));
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(request.mock.calls[0]![1].body)).toEqual({ goal: "Plan the next milestone.", responseLanguage: "en", rig: "project-1",
      planning: true, documentWorkflow: true, workflow: { entrypoint: "spec-plan", readOnly: false } });
  });

  it.each(["Coordinator", "Top bar chat"])("opens from %s and returns focus on Escape", async name => {
    await show();
    const opener = screen.getByRole("button", { name });
    opener.focus(); fireEvent.click(opener);
    const panel = screen.getByRole("dialog", { name: "Lead chat" });
    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("keeps the draft during desktop navigation and after closing and reopening", async () => {
    await show(); fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    const field = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "Keep this question" } });
    const navigate = screen.getByRole("button", { name: "Navigate" });
    fireEvent.pointerDown(navigate); fireEvent.click(navigate);
    expect(screen.getByRole("heading", { name: "Tasks" })).toBeTruthy();
    expect(screen.getByRole("dialog").getAttribute("aria-modal")).not.toBe("true");
    expect(field.value).toBe("Keep this question");
    fireEvent.click(screen.getByRole("button", { name: "Close lead chat" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Top bar chat" }));
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("Keep this question");
  });

  it("uses a modal panel at the mobile breakpoint", async () => {
    const original = window.matchMedia.bind(window);
    vi.spyOn(window, "matchMedia").mockImplementation(query => ({ ...original(query), matches: query === "(max-width: 760px)" }));
    await show(); fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    expect(screen.queryByRole("button", { name: "Navigate" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Lead chat" })).toBeTruthy();
  });

  it("retains failed messages with an error and clears the draft only after a successful send", async () => {
    request.mockRejectedValueOnce(new Error("offline"));
    await show(); fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    const field = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "  Explain the change  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("alert");
    expect(field.value).toBe("  Explain the change  ");
    expect(JSON.parse(request.mock.calls[0]![1].body)).toMatchObject({ runId: RUN_ID, expectedEntityVersion: 3, payload: { body: "Explain the change" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(field.value).toBe(""));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders exactly the pending-decision list used by the notification badge", async () => {
    const data = read({ run: { ...read().run, phase: "planning", state: "blocked", stateReasonKey: "team.reason.retryLimitExhausted" } });
    const decision = { id: "question-1", sender: "lead" as const, kind: "decision" as const,
      body: "Which behavior?", options: ["Keep", "Change"], answeredBy: null, createdAt: "2026-11-06T00:00:00Z" };
    const conversation = { ...chat, messages: [decision, { ...decision, id: "question-2", answeredBy: "answer-2" }] };
    await show(data, conversation); fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    const decisions = screen.getByRole("region", { name: "Needs your attention" });
    expect(within(decisions).getAllByRole("listitem")).toHaveLength(pendingOwnerDecisions(data, conversation).length);
    expect(within(decisions).getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(within(decisions).getByRole("button", { name: "Keep" }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(JSON.parse(request.mock.calls[0]![1].body).payload).toEqual({ responseLanguage: "en", body: "Keep", answerTo: "question-1" });
  });

  it.each(["Use a custom response, not either option.", "Confirm plan"])("links a typed answer to its question without granting approval: %s", async answer => {
    const question = { id: "question-1", sender: "lead" as const, kind: "decision" as const, body: "Which behavior?",
      options: ["Keep", "Change"], answeredBy: null, createdAt: "2026-11-08T00:00:00Z" };
    await show(planningRead(), { ...documentChat(true), messages: [question], pendingDecision: question });
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    expect((screen.getByRole("button", { name: "Approve plan" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: answer } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]![0]).toBe(`/runs/${RUN_ID}/chat`);
    expect(JSON.parse(request.mock.calls[0]![1].body).payload).toEqual({ responseLanguage: "en", body: answer, answerTo: question.id });
  });

  it("requests requirements from conversation without approving execution", async () => {
    const conversation = documentChat();
    conversation.documentWorkflow = { ...conversation.documentWorkflow!, stage: "exploration", versions: [] };
    conversation.planApproval = null;
    await show(planningRead(), conversation);
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "整理需求" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]![0]).toBe(`/runs/${RUN_ID}/documents/stage`);
    expect(JSON.parse(request.mock.calls[0]![1].body).payload).toEqual({ responseLanguage: "en", stage: "requirements", ownerMessage: "整理需求" });
  });

  it("does not request a plan from conversation before confirming requirements", async () => {
    const conversation = documentChat();
    conversation.documentWorkflow = { ...conversation.documentWorkflow!, stage: "requirements", versions: [], confirmed: { brainstorm: null, requirements: null, plan: null } };
    await show(planningRead(), conversation);
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "生成计划" } });
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(request).not.toHaveBeenCalled();
  });

  it("submits the exact roster digest read from chat with plan approval", async () => {
    request.mockResolvedValueOnce({ phase: "planning", messages: [], planApproval });
    const conversation = await readChat(request, RUN_ID);
    await show(planningRead(), conversation);
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[0]![0]).toBe(`/runs/${RUN_ID}/chat`);
    expect(request.mock.calls[1]![0]).toBe(`/runs/${RUN_ID}/plan/approve`);
    expect(JSON.parse(request.mock.calls[1]![1].body)).toMatchObject({ runId: RUN_ID, expectedEntityVersion: 3 });
    expect(JSON.parse(request.mock.calls[1]![1].body).payload).toEqual({
      responseLanguage: "en", rosterDigest: "reviewed-roster-digest", planHash: "plan-hash", ownerMessage: "Approve plan",
    });
  });

  it("approves the displayed document plan and team in the current interface language", async () => {
    const conversation = documentChat(true);
    const view = await show(planningRead(), conversation);
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    await act(async () => { await view.language.changeLanguage("zh-CN"); });
    const label = view.language.instance.t("team.plan.approve");
    fireEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]![0]).toBe(`/runs/${RUN_ID}/plan/approve`);
    expect(JSON.parse(request.mock.calls[0]![1].body).payload).toEqual({
      responseLanguage: "zh-CN", ownerMessage: label, planHash: "plan-hash", rosterDigest: "reviewed-roster-digest",
      documentVersions: conversation.planApproval!.documentVersions,
    });
  });

  it("waits for the active lead planning turn before enabling approval", async () => {
    await show({ ...planningRead(), attempts: [attempt({ role: "lead", state: "running" })] }, planningChat());
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    const approve = screen.getByRole("button", { name: "Approve plan" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.click(approve);
    expect(request).not.toHaveBeenCalled();
  });

  it("shows the proposed plan and team rather than only the existing lead seat", async () => {
    await show(planningRead(), planningChat());
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    expect(screen.getByText(/Build two independent modules/)).toBeTruthy();
    const roster = screen.getByRole("group", { name: "Proposed team" });
    expect(within(roster).getByText("Implementer · Claude Code")).toBeTruthy();
    expect(within(roster).getByText("Implementer · Codex")).toBeTruthy();
    expect(within(roster).getByText("Reviewer · Claude Code")).toBeTruthy();
  });

  it.each([
    ["unread proposal", undefined],
    ["missing plan", { ...planApproval, plan: null }],
    ["empty plan", { ...planApproval, plan: { ...planApproval.plan, content: "  " } }],
    ["missing roster", { ...planApproval, roster: null }],
    ["missing digest", { ...planApproval, roster: { ...planApproval.roster, digest: "" } }],
    ["invalid roster", { ...planApproval, error: "The roster exceeds team.maxSeats (6, excluding the lead)." }],
  ])("does not submit approval with %s", async (_name, evidence) => {
    await show(planningRead(), { ...planningChat(), planApproval: evidence });
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    const approve = screen.getByRole("button", { name: "Approve plan" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.click(approve);
    expect(request).not.toHaveBeenCalled();
    if (evidence?.error) expect(screen.getByRole("alert").textContent).toBe(evidence.error);
  });

  it("does not submit approval when the chat read is unavailable", async () => {
    await show(planningRead(), { ...planningChat(), available: false });
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    const approve = screen.getByRole("button", { name: "Approve plan" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.click(approve);
    expect(request).not.toHaveBeenCalled();
  });

  it("approves legacy planning runs that have no roster proposal", async () => {
    await show(planningRead(), { ...planningChat(), planApproval: null });
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(JSON.parse(request.mock.calls[0]![1].body).payload).toEqual({ responseLanguage: "en", ownerMessage: "Approve plan" });
  });

  it.each(["Confirm plan", "批准执行"])("uses the original combined approval for a pre-roster conversation: %s", async body => {
    await show(planningRead(), { ...planningChat(), planApproval: null });
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: body } });
    expect(screen.getByText("This legacy record uses one approval for its plan and team. Sending starts execution.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]![0]).toBe(`/runs/${RUN_ID}/plan/approve`);
    expect(JSON.parse(request.mock.calls[0]![1].body).payload).toEqual({ responseLanguage: "en", ownerMessage: body });
  });

  it("does not use the pre-roster shortcut when plan evidence is still loading", async () => {
    await show(planningRead(), { ...planningChat(), planApproval: undefined });
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Confirm plan" } });
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
    expect(request).not.toHaveBeenCalled();
  });

  it("uses the refreshed roster displayed by the next chat read", async () => {
    const view = await show(planningRead(), planningChat());
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    view.updateConversation({ ...planningChat(), planApproval: { ...planApproval,
      plan: { content: "# Revised stock utilities", hash: "updated-plan-hash" },
      roster: { seats: [{ role: "implementer", client: "codex" }], digest: "updated-roster-digest" },
    } });
    const roster = screen.getByRole("group", { name: "Proposed team" });
    expect(within(roster).queryByText("Implementer · Claude Code")).toBeNull();
    expect(within(roster).getByText("Implementer · Codex")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(JSON.parse(request.mock.calls[0]![1].body).payload).toEqual({ responseLanguage: "en", rosterDigest: "updated-roster-digest", planHash: "updated-plan-hash", ownerMessage: "Approve plan" });
  });

  it("confirms the displayed document through conversation without starting execution", async () => {
    await show(planningRead(), documentChat());
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "确认计划" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]![0]).toBe(`/runs/${RUN_ID}/documents/confirm`);
    expect(JSON.parse(request.mock.calls[0]![1].body).payload).toEqual({ responseLanguage: "en", kind: "plan", versionId: "plan-2", hash: "plan-hash", ownerMessage: "确认计划" });
  });

  it.each(["先别确认计划", "确认计划，但先修改测试", "Looks good"])("keeps ambiguous or revision text as discussion: %s", async body => {
    await show(planningRead(), documentChat());
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: body } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]![0]).toBe(`/runs/${RUN_ID}/chat`);
  });

  it("uses the exact displayed pins for an explicit conversation execution approval", async () => {
    await show(planningRead(), documentChat(true));
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "批准执行" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]![0]).toBe(`/runs/${RUN_ID}/plan/approve`);
    expect(JSON.parse(request.mock.calls[0]![1].body).payload).toEqual({ responseLanguage: "en", ownerMessage: "批准执行", planHash: "plan-hash",
      rosterDigest: "reviewed-roster-digest", documentVersions: documentChat(true).planApproval?.documentVersions });
  });

  it("keeps legacy conversation approval bound to the plan it displays", async () => {
    await show(planningRead(), planningChat());
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Confirm plan" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]![0]).toBe(`/runs/${RUN_ID}/plan/approve`);
    expect(JSON.parse(request.mock.calls[0]![1].body).payload).toEqual({ responseLanguage: "en", ownerMessage: "Confirm plan", planHash: "plan-hash", rosterDigest: "reviewed-roster-digest" });
  });

  it("does not confirm through conversation while a planning turn is still active", async () => {
    const data = planningRead(); data.attempts = [attempt({ role: "lead", state: "running" })];
    await show(data, documentChat());
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "确认计划" } });
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(request).not.toHaveBeenCalled();
  });

  it("offers a planning repair instead of leaving a missing roster as a dead end", async () => {
    await show(planningRead(), { ...planningChat(), planApproval: { ...planApproval, roster: null, error: "The lead wrote no readable lead-roster.json beside the plan." } });
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask lead to complete the plan" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]![0]).toBe(`/runs/${RUN_ID}/chat`);
    expect(JSON.parse(request.mock.calls[0]![1].body).payload.body).toContain("Keep implementation stopped");
  });

  it("does not treat a recorded owner confirmation as a pending lead turn", async () => {
    const conversation = documentChat(true);
    conversation.messages = [{ id: "confirmed-plan", sender: "owner", kind: "confirmation", body: "确认计划", options: null,
      answeredBy: null, createdAt: "2026-11-08T00:00:00.000Z" }];
    await show(planningRead(), conversation);
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    expect(screen.getByText("Confirmation recorded")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Approve plan" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("reports an approval failure without automatically retrying the proposal", async () => {
    request.mockRejectedValueOnce(new Error("lead_roster_refused"));
    await show(planningRead(), planningChat());
    fireEvent.click(screen.getByRole("button", { name: "Coordinator" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Approval failed. Review the current plan and team before trying again.",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
});
