import { useEffect, useState, type RefObject } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { TeamOwnerRead } from "@openrig/daemon/team-control";
import { useOwnerSession } from "../hooks/useOwnerSession.js";
import { approvePlan, sendChatMessage, type ChatMessage, type ChatState } from "./clients.js";
import { Check, ChevronRight } from "./glyphs.js";

type OwnerDecision = { kind: "plan" } | { kind: "resume" } | { kind: "message"; message: ChatMessage };

/** The badge and the visible decision rows consume this same list. */
export function pendingOwnerDecisions(read: TeamOwnerRead | undefined, chat: ChatState | undefined): OwnerDecision[] {
  const decisions: OwnerDecision[] = [];
  if (read?.run.phase === "planning") decisions.push({ kind: "plan" });
  if (read?.run.state === "blocked") decisions.push({ kind: "resume" });
  for (const message of chat?.available ? chat.messages : []) {
    if (message.kind === "decision" && !message.answeredBy) decisions.push({ kind: "message", message });
  }
  return decisions;
}

export function ChatPanel({ open, onOpenChange, opener, read, runId, chat }: {
  open: boolean; onOpenChange: (open: boolean) => void; opener: RefObject<HTMLButtonElement | null>;
  read?: TeamOwnerRead; runId: string; chat?: ChatState;
}) {
  const { t } = useTranslation();
  // The shell keeps this component mounted; closing its dialog or changing sections keeps the draft.
  const [draft, setDraft] = useState("");
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const update = () => setMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return <Dialog.Root open={open} onOpenChange={onOpenChange} modal={mobile}>
    <Dialog.Overlay className="ui-dialog-overlay" />
    <Dialog.Content className="ui-chat-panel" onInteractOutside={event => {
      if (!mobile) event.preventDefault();
    }} onCloseAutoFocus={event => {
      event.preventDefault(); opener.current?.focus();
    }}>
      <header className="ui-panel-heading">
        <div><Dialog.Title>{t("shell.leadChat")}</Dialog.Title>
          <Dialog.Description>{read?.run.displayName || t("shell.noRun")}</Dialog.Description></div>
        <Dialog.Close className="ui-icon-button" aria-label={t("shell.closeChat")}><X aria-hidden="true" /></Dialog.Close>
      </header>
      <LeadConversation read={read} runId={runId} chat={chat} draft={draft} onDraftChange={setDraft} />
    </Dialog.Content>
  </Dialog.Root>;
}

/** Shared with the retained run page, including its existing approval and resume controls. */
export function LeadConversation({ read, runId, chat, draft, onDraftChange }: {
  read?: TeamOwnerRead; runId: string; chat?: ChatState; draft: string; onDraftChange: (draft: string) => void;
}) {
  const { t } = useTranslation();
  const entityVersion = read?.run.entityVersion ?? 0;
  const pending = pendingOwnerDecisions(read, chat);
  return <section className="chat" aria-label={t("team.chat.message")}>
    <div className="chat-log">
      {pending.length > 0 && <section aria-label={t("shell.ownerDecisions")}>
        <h3 className="ui-attention-heading">{t("shell.ownerDecisions")}</h3>
        <ul className="ui-decision-list">{pending.map(decision => <li key={decision.kind === "message" ? decision.message.id : decision.kind}>
          {decision.kind === "plan" ? <PlanPlate read={read} runId={runId} entityVersion={entityVersion} />
            : decision.kind === "resume" ? <ResumePlate read={read!} />
              : <DecisionPlate message={decision.message} runId={runId} entityVersion={entityVersion} />}
        </li>)}</ul>
      </section>}
      {chat?.available && chat.messages.filter(message => message.kind !== "decision" || message.answeredBy)
        .map(message => <Turn key={message.id} message={message} />)}
      {read?.run.phase !== "planning" && <PlanPlate read={read} runId={runId} entityVersion={entityVersion} />}
      {chat && !chat.available && <p className="muted">{t("team.chat.unavailable")}</p>}
    </div>
    {chat?.available && <Composer runId={runId} entityVersion={entityVersion} body={draft} onBodyChange={onDraftChange} />}
  </section>;
}

function Turn({ message }: { message: ChatMessage }) {
  const { t } = useTranslation();
  const owner = message.sender === "owner";
  return <div className={owner ? "turn turn-owner" : "turn"}>
    <div className="turn-who">{owner ? t("team.chat.you") : t("role.lead")}</div>
    <p className="turn-body" style={{ whiteSpace: "pre-line" }}>{message.body}</p>
  </div>;
}

/**
 * A decision is a plate, not a dialog: the lead's question, then one row per option. Choosing
 * sends that option's text back with `answerTo`, which is the only thing that tells the lead
 * which question was answered.
 */
function DecisionPlate({ message, runId, entityVersion }: { message: ChatMessage; runId: string; entityVersion: number }) {
  const { t } = useTranslation();
  const { request } = useOwnerSession();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [question, ...context] = message.body.split("\n\n");
  const answer = async (option: string) => {
    if (busy) return;
    setBusy(true); setFailed(false);
    try { await sendChatMessage(request, runId, option, entityVersion, message.id); } catch { setFailed(true); } finally { setBusy(false); }
  };
  return <div className="plate plate-waiting" role="group" aria-label={t("team.chat.message")}>
    <h2 className="plate-title">{question}</h2>
    {context.length > 0 && <p className="plate-meta" style={{ whiteSpace: "pre-line" }}>{context.join("\n\n")}</p>}
    {failed && <p role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>{t("web.error")}</p>}
    <div className="options">
      {(message.options ?? []).map(option => <button key={option} className="option" disabled={busy} onClick={() => void answer(option)}>
        {option}
        <ChevronRight />
      </button>)}
    </div>
  </div>;
}

function Composer({ runId, entityVersion, body, onBodyChange }: {
  runId: string; entityVersion: number; body: string; onBodyChange: (body: string) => void;
}) {
  const { t } = useTranslation();
  const { request } = useOwnerSession();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return <form className="composer" onSubmit={async event => {
    event.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true); setFailed(false);
    try { await sendChatMessage(request, runId, body.trim(), entityVersion); onBodyChange(""); }
    catch { setFailed(true); } finally { setBusy(false); }
  }}>
    {failed && <p role="alert" className="composer-error">{t("web.error")}</p>}
    <textarea rows={1} aria-label={t("team.chat.message")} value={body} onChange={event => onBodyChange(event.target.value)} />
    <button className="btn btn-primary" type="submit" disabled={busy || !body.trim()}>{t("team.chat.send")}</button>
  </form>;
}

/**
 * The plan, as the record's first plate. It carries the plan's title and how many tasks the
 * work became; the breakdown itself is the lead's, so the plate approves the plan and shows
 * nothing to approve item by item.
 */
function PlanPlate({ read, runId, entityVersion }: { read?: TeamOwnerRead; runId: string; entityVersion: number }) {
  const { t } = useTranslation();
  const { request } = useOwnerSession();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!read) return null;
  const approved = read.run.phase !== "planning";
  const work = read.tasks.filter(task => task.role !== "reviewer").length;
  return <div className={approved ? "plate" : "plate plate-waiting"} role="group" aria-label={t("team.plan.approve")}>
    <h2 className="plate-title">{read.run.displayName}</h2>
    <div className="plate-meta">{t("team.plan.work", { count: work })}</div>
    {failed && <p role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>{t("web.error")}</p>}
    <div className="plate-foot">
      {approved ? <span className="plate-done"><Check />{t("team.plan.approvedShort")}</span>
        : <button className="btn btn-primary" disabled={busy} onClick={async () => {
          setBusy(true); setFailed(false);
          try { await approvePlan(request, runId, entityVersion); } catch { setFailed(true); } finally { setBusy(false); }
        }}>{t("team.plan.approve")}</button>}
    </div>
  </div>;
}

/**
 * U8 — a blocked run's one owner action. A budget block cannot be resumed without raising that
 * budget, so the same click raises it by the amount the run already had, and the plate states
 * the amount before it is taken.
 */
function ResumePlate({ read }: { read: TeamOwnerRead }) {
  const { t } = useTranslation();
  const { request } = useOwnerSession();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const run = read.run;
  const limits = run.binding.limits;
  const minutes = Math.max(1, Math.round(limits.maxActiveMs / 60_000));
  const retries = Math.max(1, limits.maxRetries);
  const rounds = Math.max(1, limits.maxReviewRounds);
  const increase =
    run.stateReasonKey === "team.reason.activeWallClockBudget" ? { addMinutes: minutes }
      : run.stateReasonKey === "team.reason.retryLimitExhausted" ? { addRetries: retries }
        : run.stateReasonKey === "team.reason.reviewLimitExhausted" ? { addReviewRounds: rounds }
          : {};
  return <div className="plate plate-waiting" role="group" aria-label={t("team.resume.action")}>
    <h2 className="plate-title">{run.stateReasonKey ? t(run.stateReasonKey) : run.stateReason}</h2>
    {run.stateReasonKey === "team.reason.activeWallClockBudget" && <p className="plate-meta">{t("team.resume.minutes", { count: minutes })}</p>}
    {run.stateReasonKey === "team.reason.retryLimitExhausted" && <p className="plate-meta">{t("team.resume.retries", { count: retries })}</p>}
    {run.stateReasonKey === "team.reason.reviewLimitExhausted" && <p className="plate-meta">{t("team.resume.rounds", { count: rounds })}</p>}
    {failed && <p role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>{t("web.error")}</p>}
    <div className="plate-foot">
      <button className="btn btn-primary" disabled={busy} onClick={async () => {
        setBusy(true); setFailed(false);
        try {
          await request(`/runs/${encodeURIComponent(run.id)}/resume`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ protocolVersion: "1.0", runId: run.id, actionId: crypto.randomUUID(),
              expectedEntityVersion: run.entityVersion, idempotencyKey: crypto.randomUUID(), payload: increase }),
          });
        } catch { setFailed(true); } finally { setBusy(false); }
      }}>{t("team.resume.action")}</button>
    </div>
  </div>;
}
