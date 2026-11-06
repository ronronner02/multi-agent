import React, { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import { ChatPanel, pendingOwnerDecisions } from "../chat-panel.js";
import type { ChatState } from "../clients.js";
import { read, RUN_ID } from "./fixtures.js";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../hooks/useOwnerSession.js", () => ({ useOwnerSession: () => ({ request }) }));
const chat: ChatState = { available: true, phase: "delivery", pendingDecision: null, messages: [] };

beforeEach(() => { request.mockReset().mockResolvedValue({}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function show(data = read(), conversation = chat) {
  const language = await createInterfaceI18n({ language: "en" });
  function Harness() {
    const [open, setOpen] = useState(false);
    const [section, setSection] = useState("Overview");
    const opener = useRef<HTMLButtonElement>(null);
    return <div>
      <button onClick={event => { opener.current = event.currentTarget; setOpen(true); }}>Coordinator</button>
      <button onClick={event => { opener.current = event.currentTarget; setOpen(true); }}>Top bar chat</button>
      <button onClick={() => setSection("Tasks")}>Navigate</button><h1>{section}</h1>
      <ChatPanel open={open} onOpenChange={setOpen} opener={opener} read={data} runId={RUN_ID} chat={conversation} />
    </div>;
  }
  return render(<I18nextProvider i18n={language.instance}><Harness /></I18nextProvider>);
}

describe("persistent lead chat", () => {
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
    expect(JSON.parse(request.mock.calls[0]![1].body).payload).toEqual({ body: "Keep", answerTo: "question-1" });
  });
});
