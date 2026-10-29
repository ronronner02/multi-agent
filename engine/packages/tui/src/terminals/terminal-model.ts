import { stripVTControlCharacters, promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { OwnerTerminalHost, OwnerTerminalHostClient, type OwnerTerminalRelay, type OwnerTerminalAttachment } from "../../../daemon/dist/terminal/owner-terminal-host.js";
import type { DaemonClient } from "../daemon-client.js";
import type { ExplorerRow, FleetSnapshot, ViewState } from "../types.js";
import { wrapDetailLines, type ContentLine } from "../detail.js";

export interface TerminalEntry {
  view: string;
  name: string;
  kind: "saved" | "derived";
  members: string[];
  readinessUnverified?: boolean;
  ready: number;
  absent: number;
  degraded: number;
  pages: number;
}

export interface TerminalPreview {
  view: string;
  provider: string;
  planId: string;
  status: { available: boolean };
  composed: {
    id: string;
    pages: Array<Array<{ seat: string; label: string; readOnly: boolean; paneCommand: string }>>;
    opened: Array<{ seat: string }>;
    absent: Array<{ seat: string; reason: string }>;
    degraded: Array<{ seat: string; reason: string }>;
  };
  grids: Array<{ columns: number; rows: number; blanks: number }>;
}

export interface TerminalRead {
  catalog: TerminalEntry[];
  catalogLoaded?: boolean;
  daemonTarget?: string;
  preview: TerminalPreview | null;
  error?: string;
}

export async function readTerminals(client: DaemonClient, view?: string | null): Promise<TerminalRead> {
  const result: TerminalRead = { catalog: [], preview: null };
  // Display the endpoint without URL credentials, query parameters or fragments.
  try { result.daemonTarget = new URL(client.baseUrl).origin; } catch { /* unavailable target */ }
  try {
    const listing = await client.terminalViews();
    if (!Array.isArray(listing.saved) || !Array.isArray(listing.rigs)) throw new Error("Terminal names could not be read.");
    result.catalog = [
      ...listing.saved.map(s => ({ view: `saved:${s.id}`, name: s.name, kind: "saved" as const, members: s.members.map(m => m.seat) })),
      ...listing.rigs.map(name => ({ view: `rig:${name}`, name, kind: "derived" as const, members: [] })),
    ].map(entry => ({ ...entry, readinessUnverified: true, ready: 0, absent: 0, degraded: 0, pages: 0 }));
    result.catalogLoaded = true;
    if (view) result.preview = await client.previewTerminal(view);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

export function terminalExplorerRows(state: ViewState, snap: FleetSnapshot): ExplorerRow[] {
  if (!snap.terminals || (snap.terminals.error && !snap.terminals.catalogLoaded && !snap.terminals.catalog.length)) return [];
  const entries = snap.terminals.catalog;
  const rows: ExplorerRow[] = [];
  for (const kind of ["saved", "derived"] as const) {
    const key = `terminals:${kind}`;
    const open = kind === "saved" || state.expanded.includes(key) || !!state.filter;
    rows.push({ label: `  ${kind === "saved" ? "Saved" : `${open ? "▾" : "▸"} Derived`} (${entries.filter(e => e.kind === kind).length})`, key,
      action: kind === "saved" ? { type: "noop" } : { type: "toggle-expand", key } });
    if (!open) continue;
    for (const entry of entries.filter(e => e.kind === kind && `${e.name} ${e.members.join(" ")}`.toLowerCase().includes(state.filter.toLowerCase()))) {
      rows.push({ label: `    ${entry.name}${entry.readinessUnverified ? "" : ` · ${entry.ready}/${entry.members.length}`}`, key: `terminal:${entry.view}`, action: { type: "terminal-preview", view: entry.view } });
    }
  }
  return rows;
}

export function terminalLines(state: ViewState, snap: FleetSnapshot, width: number): ContentLine[] {
  const read = snap.terminals;
  const lines: ContentLine[] = [{ text: "TERMINALS · Saved and Derived views" }];
  if (state.terminalResult && state.terminalResult.view === state.terminalView) lines.push({ text: `Last Open result: ${state.terminalResult!.message}` });
  if (!read) return [...lines, { text: "Reading terminal views…" }];
  if (read.error) lines.push({ text: `Unavailable: ${read.error}` });
  if (read.error && !read.catalogLoaded && !read.catalog.length) return wrapDetailLines(lines, width);
  const preview = read.preview?.view === state.terminalView ? read.preview : null;
  if (state.terminalView && !preview) {
    lines.push({ text: "Back to terminal views", action: { type: "back" } });
    return wrapDetailLines(lines, width);
  }
  if (!preview) {
    lines.push({ text: "Browse and preview are passive. Choose a view, then Open terminals to request a desktop window." });
    for (const kind of ["saved", "derived"] as const) {
      const entries = read.catalog.filter(e => e.kind === kind && `${e.name} ${e.members.join(" ")}`.toLowerCase().includes(state.filter.toLowerCase()));
      const open = kind === "saved" || state.expanded.includes("terminals:derived") || !!state.filter;
      lines.push({ text: "" }, { text: `${kind === "saved" ? "Saved" : `${open ? "▾" : "▸"} Derived`} · ${entries.length} views`,
        ...(kind === "derived" ? { action: { type: "toggle-expand" as const, key: "terminals:derived" } } : {}) });
      if (!open) continue;
      if (!entries.length) lines.push({ text: kind === "saved" ? "No saved views. Existing terminal-views.yaml stores membership, not custom geometry." : "No derived rig views available." });
      for (const entry of entries) {
        lines.push({ text: `${entry.name} · ${entry.readinessUnverified ? (entry.kind === "saved" ? `${entry.members.length} saved members · Preview readiness` : "Preview members and readiness") : `${entry.members.length} members · ${entry.ready} attachable · ${entry.absent + entry.degraded} unavailable · ${entry.pages} pages`}`, action: { type: "terminal-preview", view: entry.view } });
        if (entry.kind === "saved") lines.push({ text: `  ${entry.members.join(", ") || "Empty view"}` });
      }
    }
    return wrapDetailLines(lines, width);
  }

  const plan = preview.composed;
  const pageIndex = Math.min(Math.max(0, state.terminalPage ?? 0), Math.max(0, plan.pages.length - 1));
  const page = plan.pages[pageIndex] ?? [];
  const grid = preview.grids[pageIndex];
  lines.push({ text: preview.view }, { text: `${plan.opened.length} attachable · ${plan.absent.length} absent · ${plan.degraded.length} degraded` });
  // Actions precede the diagram so explicit Open/Back remain accessible at 80×24.
  lines.push({ text: "Back to views", action: { type: "back" } });
  if (plan.opened.length) {
    lines.push({ text: `Open terminals ▸ all ${plan.pages.length} pages`, action: { type: "act", act: "open-terminal", view: preview.view, expectedPlan: preview.planId } });
  } else lines.push({ text: "Nothing attachable; no space will be opened." });
  lines.push({ text: "Refresh preview", action: { type: "terminal-preview", view: preview.view } });
  if (plan.pages.length > 1) {
    if (pageIndex > 0) lines.push({ text: "Previous page", action: { type: "terminal-page", page: pageIndex - 1 } });
    if (pageIndex + 1 < plan.pages.length) lines.push({ text: "Next page", action: { type: "terminal-page", page: pageIndex + 1 } });
  }
  lines.push({ text: `Page ${plan.pages.length ? pageIndex + 1 : 0}/${plan.pages.length}${grid ? ` · ${grid.columns} columns × ${grid.rows} rows · ${grid.blanks} filler cells` : ""}` });
  if (grid) {
    const cellWidth = Math.max(4, Math.floor((width - 1) / grid.columns) - 1);
    const border = "+" + Array(grid.columns).fill("-".repeat(cellWidth)).join("+") + "+";
    lines.push({ text: border });
    for (let row = 0; row < grid.rows; row++) {
      const cells = Array.from({ length: grid.columns }, (_, col) => {
        const index = row * grid.columns + col;
        return (page[index] ? `${index + 1}${page[index]!.readOnly ? " RO" : " RW"}` : "blank").padEnd(cellWidth);
      });
      lines.push({ text: "|" + cells.join("|") + "|" }, { text: border });
    }
  }
  page.forEach((member, index) => {
    lines.push({ text: `${index + 1}. ${member.label} · ${member.readOnly ? "read-only" : "interactive"}` }, { text: `   ${member.seat}${member.paneCommand.startsWith("ssh ") ? " · SSH login unverified; opened pane will attempt connection" : ""}` });
  });
  lines.push({ text: "Auto-layout: equal cells, at most 9 members per page. Blank cells fill incomplete rectangles. Saved views store membership only; no custom geometry editor." });
  for (const member of [...plan.absent, ...plan.degraded]) lines.push({ text: `Unavailable · ${member.seat}: ${member.reason}` });
  if (page.length) {
    lines.push({ text: "On a desktop, opens a new terminal tab or window: Herdr if installed, otherwise the same layout in plain tmux." });
    lines.push({ text: `Run this TUI on the selected daemon's desktop (${read.daemonTarget ?? "address unreported"}). Existing conversations stay in place.` });
    lines.push({ text: `Headless or remote: open a NEW terminal/tab on the machine running the selected daemon (${read.daemonTarget ?? "address unreported"}), then attach with one command below per terminal. Existing conversations stay in place.` });
    lines.push({ text: "If a command wraps, widen this terminal until it fits on one line before copying." });
    for (const member of page) {
      const command = member.paneCommand.replace(/^ssh /, "ssh -t ");
      lines.push({ text: `${member.label} · ${member.seat}` }, { text: `env -u TMUX ${command}` });
    }
  }
  return wrapDetailLines(lines, width);
}

export function createTeamTerminal(client: Pick<DaemonClient, "openTeamTerminal">,
  changed: (state: NonNullable<import("../types.js").TeamViewState["terminal"]>) => void) {
  let socket: WebSocket | null = null, attachment: OwnerTerminalAttachment | null = null, requested = false, raw = "";
  let state: NonNullable<import("../types.js").TeamViewState["terminal"]> = { session: "", status: "unavailable", lines: [] };
  const publish = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; changed(state); };
  const output = (data: string) => {
    raw = (raw + data).slice(-32768);
    publish({ lines: stripVTControlCharacters(raw).replace(/\r/g, "").split("\n").slice(-200) });
  };
  function release() {
    requested = false;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "release" }));
    if (attachment) { void attachment.close(); attachment = null; }
    publish({ status: socket?.readyState === WebSocket.OPEN ? "readOnly" : "unavailable" });
  }
  function close() { release(); const old = socket; socket = null; old?.close(); raw = ""; }
  return {
    close, release,
    open(session: string) {
      close(); publish({ session, status: "connecting", lines: [] });
      const ws = client.openTeamTerminal(session); socket = ws;
      const nonce = new URL(ws.url).searchParams.get("nonce");
      const deadline = setTimeout(() => { if (socket === ws && state.status === "connecting") { ws.close(); publish({ status: "unavailable" }); } }, 5000);
      deadline.unref?.();
      ws.onmessage = event => {
        if (socket !== ws) return;
        let frame: Record<string, unknown>;
        try { frame = JSON.parse(String(event.data)); } catch { return; }
        if (!nonce || frame.nonce !== nonce) return;
        if (frame.type === "output" && frame.session === session && typeof frame.data === "string") output(frame.data);
        if (frame.type === "ready" && frame.session === session) { clearTimeout(deadline); publish({ status: "readOnly" }); }
        if (frame.type === "takeover" && frame.session === session) {
          if (frame.status === "active" && requested) { requested = false; publish({ status: "active" }); }
          else if (frame.status === "released" || frame.status === "inactive") { requested = false; publish({ status: "readOnly" }); }
        }
        if (frame.type === "error") { requested = false; publish({ status: "readOnly" }); }
      };
      ws.onclose = ws.onerror = () => { clearTimeout(deadline); if (socket === ws) { requested = false; publish({ status: "unavailable" }); } };
    },
    async openOwner(relay: OwnerTerminalRelay) {
      close(); publish({ session: "owner", status: "connecting", lines: [] });
      attachment = await relay.attach({ send: output, close: () => publish({ status: "unavailable" }) });
      publish({ status: "active" });
    },
    takeover() {
      if (state.status !== "readOnly" || socket?.readyState !== WebSocket.OPEN) return;
      requested = true; publish({ status: "requested" }); socket.send(JSON.stringify({ type: "takeover" }));
    },
    input(event: import("../types.js").InputEvent) {
      if (state.status !== "active") return;
      const keys: Record<string, string> = { enter: "Enter", backspace: "BSpace", up: "Up", down: "Down", left: "Left", right: "Right", tab: "Tab" };
      const text = event.type === "char" ? event.ch : event.type === "paste" ? event.text : null;
      if (attachment) {
        const bytes: Record<string, string> = { enter: "\r", backspace: "\x7f", up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", tab: "\t" };
        const data = text ?? (event.type === "key" ? bytes[event.key] : undefined);
        if (data) void attachment.sendInput(data).catch(() => publish({ status: "unavailable" }));
      } else if (socket?.readyState === WebSocket.OPEN) {
        if (text !== null) socket.send(JSON.stringify({ type: "text", text }));
        else if (event.type === "key" && keys[event.key]) socket.send(JSON.stringify({ type: "keys", keys: [keys[event.key]] }));
      }
    },
  };
}

export async function startOwnerTerminal() {
  const user = userInfo();
  if (process.platform !== "linux" || user.uid <= 0 || /^ma-(?:control|worker[0-9]+)$/.test(user.username)) throw new Error("Owner login required");
  const root = await mkdtemp(join(tmpdir(), "multi-agent-owner-")), tmuxSocket = join(root, "tmux.sock");
  const env = { ...process.env }; delete env["TMUX"]; delete env["TMUX_PANE"]; delete env["MULTI_AGENT_OWNER_TOKEN"];
  const run = promisify(execFile), quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const host = new OwnerTerminalHost({ socketPath: join(root, "relay.sock"), ownerUid: user.uid, transportFactory: () => {
    let child: ReturnType<typeof spawn> | null = null;
    return {
      async start(output, closed) {
        child = spawn("script", ["-q", "-f", "-c", `tmux -S ${quote(tmuxSocket)} attach-session -t owner`, "/dev/null"], { env });
        child.stdout!.on("data", data => output(data.toString())); child.stderr!.on("data", data => output(data.toString()));
        child.on("exit", () => closed()); child.on("error", () => closed("Owner terminal process failed"));
      },
      async write(data) { child?.stdin?.write(data); },
      async close() { child?.kill("SIGTERM"); },
    };
  } });
  const close = async () => { await host.stop(); await run("tmux", ["-S", tmuxSocket, "kill-server"], { env }).catch(() => {}); await rm(root, { recursive: true, force: true }); };
  try {
    await run("tmux", ["-S", tmuxSocket, "-f", "/dev/null", "new-session", "-d", "-s", "owner"], { env });
    await host.start();
    return { relay: new OwnerTerminalHostClient({ socketPath: host.socketPath, token: host.token }), close, socketPath: host.socketPath, tmuxSocket };
  } catch (error) { await close(); throw error; }
}
