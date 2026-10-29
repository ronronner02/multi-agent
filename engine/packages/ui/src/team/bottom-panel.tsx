import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import type { TeamAttemptView, TeamOwnerRead } from "@openrig/daemon/team-control";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.js";
import { mapXtermInput, applyOpaqueTerminalBackground } from "../components/terminal/FocusedTerminal.js";
import { LIVE_TERMINAL_COLS, LIVE_TERMINAL_ROWS, LIVE_TERMINAL_FONT_SIZE, LIVE_TERMINAL_LINE_HEIGHT, LIVE_TERMINAL_FONT_FAMILY, LIVE_TERMINAL_RENDER_BACKGROUND } from "../components/terminal/terminal-geometry.js";
import { useOwnerSession } from "../hooks/useOwnerSession.js";
import { Logs } from "./logs.js";
import { OwnerDialog } from "./decision-dialog.js";
import "@xterm/xterm/css/xterm.css";

export type TerminalTarget = TeamAttemptView | "owner" | null;
type TerminalState = "web.loading" | "team.readOnly" | "team.requested" | "web.inputEnabled" | "team.unavailable";

export function ManagedTerminal({ target, available }: { target: Exclude<TerminalTarget, null>; available: boolean }) {
  const { t } = useTranslation();
  const { openTerminal, terminalAvailable } = useOwnerSession();
  const outer = useRef<HTMLDivElement>(null), container = useRef<HTMLDivElement>(null), terminal = useRef<Terminal | null>(null);
  const controls = useRef<{ takeover(): void; release(): void } | null>(null);
  const allowed = useRef(false); allowed.current = available && terminalAvailable;
  const [status, setStatus] = useState<TerminalState>("web.loading");
  const [reason, setReason] = useState<string | null>(null), [retry, setRetry] = useState(0);
  const [confirm, setConfirm] = useState<HTMLElement | null>(null);
  const owner = target === "owner", session = owner ? null : target.session;
  const identity = owner ? "owner" : JSON.stringify([target.runId, target.attemptId, target.session]);
  const currentIdentity = useRef(identity); currentIdentity.current = identity;

  useEffect(() => {
    if (!available || !terminalAvailable || !container.current || !owner && !session) return;
    const nonce = crypto.randomUUID();
    let closed = false, ready = false, active = false, requested = false;
    let socket: WebSocket;
    const term = new Terminal({ cols: LIVE_TERMINAL_COLS, rows: LIVE_TERMINAL_ROWS, fontSize: LIVE_TERMINAL_FONT_SIZE,
      lineHeight: LIVE_TERMINAL_LINE_HEIGHT, fontFamily: LIVE_TERMINAL_FONT_FAMILY, disableStdin: true, screenReaderMode: true,
      theme: { background: LIVE_TERMINAL_RENDER_BACKGROUND, foreground: "#e0e0e0" }, allowTransparency: false });
    terminal.current = term;
    term.open(container.current); applyOpaqueTerminalBackground(container.current);
    setStatus("web.loading"); setReason(null); setConfirm(null);
    const input = (enabled: boolean) => {
      active = enabled; term.options.disableStdin = !enabled;
      term.textarea?.setAttribute("aria-readonly", String(!enabled));
    };
    const fail = (code?: string) => {
      ready = false; requested = false; input(false); setStatus("team.unavailable"); if (code) setReason(code);
    };
    try { socket = openTerminal(session, nonce); } catch { fail(); term.dispose(); terminal.current = null; return; }
    const send = (frame: object) => { if (!closed && currentIdentity.current === identity && allowed.current && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame)); };
    term.onData(data => {
      if (!active || !allowed.current || closed) return;
      if (owner) send({ type: "input", data });
      else for (const frame of mapXtermInput(data)) send(frame);
    });
    controls.current = {
      takeover() {
        if (!ready || requested || active || !allowed.current || socket.readyState !== WebSocket.OPEN) return;
        requested = true; setStatus("team.requested"); send({ type: "takeover" });
      },
      release() { input(false); requested = false; setStatus("team.readOnly"); send({ type: "release" }); },
    };
    socket.onmessage = event => {
      if (closed || currentIdentity.current !== identity || !allowed.current || typeof event.data !== "string") return;
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(event.data); } catch { fail("invalid_terminal_frame"); socket.close(); return; }
      if (!frame || typeof frame !== "object") return;
      if (!owner && (frame.nonce !== nonce || frame.type !== "error" && frame.session !== session)) return;
      if (frame.type === "output" && typeof frame.data === "string") { term.write(frame.data); return; }
      if (owner) {
        if (frame.type === "status") {
          ready = frame.status === "ready"; input(ready); setStatus(ready ? "web.inputEnabled" : "team.unavailable");
        }
      } else if (frame.type === "ready") { ready = true; input(false); setStatus("team.readOnly"); }
      else if (frame.type === "takeover") {
        if (frame.status === "active" && requested && ready) { requested = false; input(true); setStatus("web.inputEnabled"); term.focus(); }
        else if (frame.status === "released" || frame.status === "inactive") { requested = false; input(false); setStatus("team.readOnly"); }
      } else if (frame.type === "error") { fail(typeof frame.code === "string" ? frame.code : undefined); socket.close(); }
    };
    socket.onclose = () => { if (!closed) fail(); };
    socket.onerror = () => { if (!closed) { fail(); socket.close(); } };
    // Fit the fixed daemon grid by font size; CSS scaling breaks native selection coordinates.
    const width = container.current.offsetWidth;
    const fit = () => { if (width > 0 && outer.current) term.options.fontSize = Math.max(2, LIVE_TERMINAL_FONT_SIZE * Math.min(1, outer.current.clientWidth / width)); };
    const observer = new ResizeObserver(fit); observer.observe(outer.current!); fit();
    return () => {
      const release = requested || active;
      closed = true; input(false); controls.current = null;
      if (!owner && release && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "release" }));
      socket.close(); observer.disconnect(); term.dispose(); terminal.current = null;
    };
  }, [identity, session, owner, available, terminalAvailable, openTerminal, retry]);
  useEffect(() => { terminal.current?.textarea?.setAttribute("aria-label", t("web.terminalInput")); }, [t, status, retry]);

  return <section tabIndex={-1} aria-label={owner ? t("web.terminal") : t("web.session")}>
    <p><code>{owner ? t("web.terminal") : session}</code> · <span role="status">{t(allowed.current ? status : "team.unavailable")}</span></p>
    {reason && <p role="alert">{reason}</p>}
    {!owner && <><Button variant="outline" disabled={!allowed.current || status !== "team.readOnly"} onClick={event => setConfirm(event.currentTarget)}>{t("web.takeover")}</Button>
      <Button variant="outline" disabled={!allowed.current || status !== "web.inputEnabled"} onClick={() => controls.current?.release()}>{t("web.release")}</Button></>}
    {status === "team.unavailable" && <Button variant="outline" disabled={!allowed.current} onClick={() => setRetry(value => value + 1)}>{t("action.retry")}</Button>}
    <div ref={outer} className="team-terminal-viewport"><div ref={container} className="team-terminal-screen" /></div>
    {confirm && !owner && <OwnerDialog title={t("team.confirm")} description={t("team.takeoverPrompt")} trigger={confirm} onClose={() => setConfirm(null)}>
      <dl className="team-detail-facts">{[[t("web.run"), target.runId], [t("web.taskId"), target.taskId], [t("web.attempt"), target.attemptId], [t("web.session"), target.session]].map(([label, value]) =>
        <div key={label}><dt>{label}</dt><dd><code>{value ?? t("value.unavailable")}</code></dd></div>)}</dl>
      <Button variant="outline" disabled={!allowed.current || status !== "team.readOnly"} onClick={() => { controls.current?.takeover(); setConfirm(null); }}>{t("web.confirmTakeover")}</Button>
    </OwnerDialog>}
  </section>;
}

export function BottomPanel({ tab, onTab, read, available, target, onTarget }: {
  tab: string; onTab: (value: string) => void; read?: Pick<TeamOwnerRead, "runId" | "attempts" | "tasks" | "logs">; available: boolean;
  target: TerminalTarget; onTarget: (target: TerminalTarget) => void;
}) {
  const { t } = useTranslation();
  const { terminalAvailable } = useOwnerSession();
  const [wide, setWide] = useState(() => window.innerWidth >= 768);
  useEffect(() => { const resize = () => setWide(window.innerWidth >= 768); window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, []);
  useEffect(() => { if (!wide && target === "owner") onTarget(null); }, [wide, target, onTarget]);
  const attempts = read?.attempts.filter(item => item.runId === read.runId && item.state === "running" && item.session && item.session !== "owner") ?? [];
  const verified = target === "owner" ? wide : !!target && attempts.some(item => item.attemptId === target.attemptId && item.runId === target.runId && item.session === target.session);
  return <Card className={"team-card team-evidence" + (tab === "terminal" ? " team-evidence-terminal" : "")} data-scroll-pane="evidence" role="region" aria-label={t("web.evidence")}>
    <h2 className="sr-only">{t("web.evidence")}</h2>
    <Tabs value={tab} onValueChange={onTab}><TabsList aria-label={t("web.evidence")}>
      <TabsTrigger value="terminal" disabled={!available || !terminalAvailable} className={!target || target === "owner" ? "team-owner-terminal" : undefined}>{t(target && target !== "owner" ? "team.terminal" : "web.terminal")}</TabsTrigger>
      <TabsTrigger value="logs">{t("web.logs")}</TabsTrigger><TabsTrigger value="review">{t("web.reviewConversation")}</TabsTrigger>
    </TabsList>
    <TabsContent value="terminal">
      <div className="team-terminal-controls"><Button variant="outline" className="team-owner-terminal" disabled={!wide || !available || !terminalAvailable} onClick={() => onTarget("owner")}>{t("web.terminal")}</Button>
        <label>{t("web.session")}<select value={target && target !== "owner" ? target.attemptId : ""} disabled={!available || !terminalAvailable}
          onChange={event => onTarget(attempts.find(item => item.attemptId === event.target.value) ?? null)}>
          <option value="">{t("web.openSession")}</option>{attempts.map(item => <option key={item.attemptId} value={item.attemptId}>{item.taskId} · {item.attemptId} · {item.session}</option>)}
        </select></label>
        <Button variant="outline" disabled={!target} onClick={() => onTarget(null)}>{t("web.closeSession")}</Button>
      </div>
      {target && verified ? <ManagedTerminal key={JSON.stringify(target)} target={target} available={available} /> : <p>{t("web.terminalPending")}</p>}
    </TabsContent>
    <TabsContent value="logs"><Logs key={read?.runId} read={read} /></TabsContent>
    <TabsContent value="review"><p>{t("web.readOnly")}</p><p>{t("value.unavailable")}</p></TabsContent>
    </Tabs>
  </Card>;
}
