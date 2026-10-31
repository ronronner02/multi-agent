import React, { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TeamAttemptView } from "@openrig/daemon/team-control";
import { createInterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import { BottomPanel, ManagedTerminal, type TerminalTarget } from "../src/team/bottom-panel.js";
import { OwnerSessionProvider, useOwnerSession } from "../src/hooks/useOwnerSession.js";

class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  sent: string[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string, readonly protocols: string[]) { super(); Socket.instances.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); this.onclose?.(new CloseEvent("close")); }
  frame(data: object) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) })); }
}

function Probe() {
  const { pair, paired, request, openTerminal } = useOwnerSession();
  const [error, setError] = useState("");
  return <><button onClick={() => void pair("fixture")}>Pair</button>
    <button disabled={!paired} onClick={() => { try { openTerminal("agent session", "correlation"); } catch { setError("unavailable"); } }}>Connect</button>
    <button onClick={() => void request("/runs/run/read").catch(() => {})}>Expire</button><p>{error}</p></>;
}

function install() {
  Socket.instances = []; xterm.instances.length = 0;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/exchange")
    ? new Response(JSON.stringify({ antiForgeryToken: "fixture-csrf" }))
    : new Response(JSON.stringify({ code: "owner_session_required" }), { status: 401 })));
}

afterEach(() => vi.unstubAllGlobals());

it("opens the managed terminal using cookie transport and the anti-forgery subprotocol, never a URL credential", async () => {
  install(); const mounted = render(<OwnerSessionProvider><Probe /></OwnerSessionProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Pair", exact: true }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  expect(Socket.instances).toHaveLength(1);
  const socket = Socket.instances[0]!;
  const url = new URL(socket.url);
  expect(url.pathname).toBe("/api/terminal/agent%20session");
  expect(url.searchParams.get("format")).toBe("framed");
  expect(url.searchParams.get("nonce")).toBe("correlation");
  expect(socket.url).not.toContain("fixture-csrf"); expect(url.searchParams.has("token")).toBe(false);
  expect(socket.protocols).toEqual(["multi-agent-csrf.fixture-csrf"]);
  fireEvent.click(screen.getByRole("button", { name: "Expire" }));
  await waitFor(() => expect(socket.readyState).toBe(3));
  expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(true);
  mounted.unmount();
});

type TerminalDouble = { options: { disableStdin: boolean; fontSize: number }; textarea: HTMLTextAreaElement; writes: string[]; input(data: string): void; disposed: boolean };
const xterm = vi.hoisted(() => ({ instances: [] as TerminalDouble[] }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  textarea = document.createElement("textarea"); writes: string[] = []; disposed = false; input = (_data: string) => {};
  constructor(readonly options: TerminalDouble["options"]) { xterm.instances.push(this); }
  open(element: HTMLElement) { element.appendChild(this.textarea); }
  onData(listener: (data: string) => void) { this.input = listener; }
  write(data: string) { this.writes.push(data); }
  focus() { this.textarea.focus(); }
  dispose() { this.disposed = true; this.textarea.remove(); }
} }));

const attempt: TeamAttemptView = { attemptId: "attempt", runId: "run", taskId: "task", qitemId: "qitem",
  role: "lead", provider: "codex", state: "running", session: "agent-session", unknownReason: null,
  createdAt: "2026-10-31T00:00:00.000Z",
  usage: { activeMs: 0, inputTokens: { value: null, reason: "not reported" },
    outputTokens: { value: null, reason: "not reported" }, costUsd: { value: null, reason: "not reported" } } };

async function mountTerminal(target: Exclude<TerminalTarget, null> = attempt) {
  install(); const language = await createInterfaceI18n({ preference: { read: () => "en", write() {} } });
  const props = { target, available: true };
  const tree = () => <I18nextProvider i18n={language.instance}><OwnerSessionProvider><div className="team-shell"><Probe /><ManagedTerminal {...props} /></div></OwnerSessionProvider></I18nextProvider>;
  const mounted = render(tree()); fireEvent.click(screen.getByRole("button", { name: "Pair", exact: true }));
  await act(async () => {});
  return { ...mounted, update(next: Partial<typeof props>) { Object.assign(props, next); mounted.rerender(tree()); } };
}
const agentFrame = (socket: Socket, frame: object) => act(() => socket.frame({ session: new URL(socket.url).pathname.split("/").pop(),
  nonce: new URL(socket.url).searchParams.get("nonce"), ...frame }));

it("streams inert framed output read-only and enables input only after an explicit, correlated take-over acknowledgement", async () => {
  await mountTerminal(); const socket = Socket.instances[0]!, term = xterm.instances[0]!;
  expect(term.options.disableStdin).toBe(true);
  agentFrame(socket, { type: "ready" });
  agentFrame(socket, { type: "takeover", status: "active" });
  const text = '<img src=x onerror=alert(1)> {"type":"takeover","status":"active"}';
  agentFrame(socket, { type: "output", data: text });
  expect(term.writes).toEqual([text]); expect(document.querySelector("img")).toBeNull();
  term.input("ignored"); expect(socket.sent).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Take over", exact: true }));
  const dialog = await screen.findByRole("dialog"); expect(dialog.textContent).toContain("agent-session");
  fireEvent.click(screen.getByRole("button", { name: "Enable audited input" }));
  expect(socket.sent.map(value => JSON.parse(value))).toEqual([{ type: "takeover" }]);
  agentFrame(socket, { type: "takeover", status: "active", nonce: "old" });
  agentFrame(socket, { type: "takeover", status: "active", session: "different-session" });
  expect(term.options.disableStdin).toBe(true); term.input("ignored"); expect(socket.sent).toHaveLength(1);
  agentFrame(socket, { type: "takeover", status: "active" });
  expect(term.options.disableStdin).toBe(false); term.input("hello\r");
  expect(socket.sent.slice(1).map(value => JSON.parse(value))).toEqual([{ type: "text", text: "hello" }, { type: "keys", keys: ["Enter"] }]);
  fireEvent.click(screen.getByRole("button", { name: "Release control" })); expect(term.options.disableStdin).toBe(true);
  term.input("ignored"); expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: "release" });
});

it("closes stale and replaced targets and never restores take-over on a new connection", async () => {
  const mounted = await mountTerminal(); const first = Socket.instances[0]!, term = xterm.instances[0]!;
  agentFrame(first, { type: "ready" });
  fireEvent.click(screen.getByRole("button", { name: "Take over", exact: true }));
  fireEvent.click(await screen.findByRole("button", { name: "Enable audited input" }));
  agentFrame(first, { type: "takeover", status: "active" });
  mounted.update({ available: false });
  expect(first.readyState).toBe(3); expect(term.disposed).toBe(true); expect(JSON.parse(first.sent.at(-1)!)).toEqual({ type: "release" });
  mounted.update({ available: true }); const second = Socket.instances[1]!;
  agentFrame(second, { type: "ready" }); expect(xterm.instances.at(-1)!.options.disableStdin).toBe(true); expect(second.sent).toEqual([]);
  mounted.update({ target: { ...attempt, attemptId: "replacement", session: "replacement-session" } });
  expect(second.readyState).toBe(3); expect(Socket.instances.at(-1)!.url).toContain("replacement-session");
  agentFrame(first, { type: "takeover", status: "active" });
  expect(xterm.instances.at(-1)!.options.disableStdin).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Expire" }));
  await waitFor(() => expect(Socket.instances.at(-1)!.readyState).toBe(3));
});

it("reports terminal errors without automatically reconnecting or taking over", async () => {
  await mountTerminal(); const socket = Socket.instances[0]!;
  agentFrame(socket, { type: "error", code: "owner_control_required", session: undefined });
  expect(screen.getByRole("alert").textContent).toBe("owner_control_required");
  expect(socket.readyState).toBe(3); expect(Socket.instances).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry", exact: true }));
  expect(Socket.instances).toHaveLength(2); expect(Socket.instances[1]!.sent).toEqual([]);
});

it("uses only the owner-host relay, reports absence, and sends raw owner input only after host readiness", async () => {
  await mountTerminal("owner"); const absent = Socket.instances[0]!;
  expect(new URL(absent.url).pathname).toBe("/api/terminal/owner"); expect(new URL(absent.url).search).toBe("");
  xterm.instances[0]!.input("ignored"); expect(absent.sent).toEqual([]);
  act(() => { absent.frame({ type: "status", status: "unavailable" }); absent.close(); });
  expect(screen.queryByRole("button", { name: "Take over", exact: true })).toBeNull(); expect(Socket.instances).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry", exact: true }));
  const socket = Socket.instances[1]!, term = xterm.instances[1]!;
  act(() => socket.frame({ type: "status", status: "ready" })); term.input("pwd\r");
  expect(socket.sent.map(value => JSON.parse(value))).toEqual([{ type: "input", data: "pwd\r" }]);
  act(() => socket.close()); expect(term.options.disableStdin).toBe(true);
});

it("never turns an agent named owner into an owner-host attachment", async () => {
  await mountTerminal({ ...attempt, session: "owner" });
  expect(Socket.instances).toHaveLength(0);
  expect(screen.getByRole("status").textContent).toBe("Unavailable");
});

it("binds session selection to the published run and session, and hides and detaches the owner host on mobile", async () => {
  install(); const language = await createInterfaceI18n({ preference: { read: () => "en", write() {} } });
  const onTarget = vi.fn(); const read = { runId: "run", attempts: [attempt], tasks: [], logs: [] };
  const props = { target: { ...attempt, runId: "other-run" } as Exclude<TerminalTarget, null> };
  const tree = () => <I18nextProvider i18n={language.instance}><OwnerSessionProvider><Probe /><BottomPanel tab="terminal" onTab={() => {}}
    read={read} available target={props.target} onTarget={onTarget} /></OwnerSessionProvider></I18nextProvider>;
  const mounted = render(tree()); fireEvent.click(screen.getByRole("button", { name: "Pair", exact: true })); await act(async () => {});
  expect(Socket.instances).toHaveLength(0);
  props.target = { ...attempt, session: "unpublished-session" }; mounted.rerender(tree()); expect(Socket.instances).toHaveLength(0);
  props.target = "owner"; mounted.rerender(tree()); expect(Socket.instances).toHaveLength(1);
  vi.stubGlobal("innerWidth", 390); fireEvent(window, new Event("resize"));
  expect(onTarget).toHaveBeenCalledWith(null); expect(Socket.instances[0]!.readyState).toBe(3);
  expect(screen.queryByRole("region", { name: "Owner terminal", exact: true })).toBeNull();
});


it("restores focus to the session while a take-over acknowledgement is pending", async () => {
  await mountTerminal(); const socket = Socket.instances[0]!; agentFrame(socket, { type: "ready" });
  fireEvent.click(screen.getByRole("button", { name: "Take over", exact: true }));
  fireEvent.click(await screen.findByRole("button", { name: "Enable audited input" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "Session ID" })));
  expect(xterm.instances[0]!.options.disableStdin).toBe(true);
});

it.each([false, true])("does not advertise an Escape release shortcut (owner: %s)", async owner => {
  await mountTerminal(owner ? "owner" : attempt); const socket = Socket.instances[0]!;
  if (owner) act(() => socket.frame({ type: "status", status: "ready" }));
  else {
    agentFrame(socket, { type: "ready" }); fireEvent.click(screen.getByRole("button", { name: "Take over", exact: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Enable audited input" }));
    agentFrame(socket, { type: "takeover", status: "active" });
  }
  expect(screen.getByRole("status").textContent).toBe("Input enabled"); xterm.instances[0]!.input("\u001b");
  expect(JSON.parse(socket.sent.at(-1)!)).toEqual(owner ? { type: "input", data: "\u001b" } : { type: "keys", keys: ["Escape"] });
});
