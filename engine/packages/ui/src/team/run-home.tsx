import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { TeamOwnerRead, TeamReviewView } from "@openrig/daemon/team-control";
import { useOwnerSession } from "../hooks/useOwnerSession.js";
import { approvePlan, mergeBranch, sendChatMessage, type ChatMessage, type IntegrationState } from "./clients.js";
import { branchName, isFinished, readableBranch, seatLabel, stateLabel, stateOf, taskName } from "./display.js";
import { Check, ChevronRight } from "./glyphs.js";
import { useIntegration, useTeamChat } from "./hooks.js";

/**
 * U10 — the run home.
 *
 * The lead's conversation is the protagonist: text turns, and the decisions it needs as plates
 * in the record. Beside it the run's tasks are one line that ends at the merge plate, which
 * stays closed until U7 says the branch can merge. The lead admits its own task list now, so
 * the plate here approves the plan and nothing else.
 */
export function RunHome({ read, runId, available, now, onOpenTask, onOpenBranch }: {
  read?: TeamOwnerRead; runId: string; available: boolean; now: number;
  onOpenTask: (taskId: string) => void; onOpenBranch: () => void;
}) {
  const { t } = useTranslation();
  const chat = useTeamChat(runId, available);
  const integration = useIntegration(runId, available);
  const tasks = read?.tasks ?? [];
  const remaining = tasks.filter(task => !isFinished(task)).length;
  const entityVersion = read?.run.entityVersion ?? 0;

  return <>
    <button className="line-strip" onClick={onOpenBranch}>
      <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span className="label">{t("team.line.title")}</span>
        <span className="now">{activeName(tasks, t) ?? "—"}</span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span className="count">{tasks.length - remaining} / {tasks.length}</span>
        <ChevronRight />
      </span>
    </button>

    <main className="home">
      <section className="chat" aria-label={t("team.chat.message")}>
        <div className="chat-log">
          {chat.data?.available
            ? chat.data.messages.map(message => message.kind === "decision" && !message.answeredBy
              ? <DecisionPlate key={message.id} message={message} runId={runId} entityVersion={entityVersion} />
              : <Turn key={message.id} message={message} />)
            : null}
          <PlanPlate read={read} runId={runId} entityVersion={entityVersion} />
          {chat.data && !chat.data.available && <p className="muted" style={{ fontSize: 13 }}>{t("team.chat.unavailable")}</p>}
          {read?.run.state === "blocked" && <ResumePlate read={read} />}
        </div>
        {chat.data?.available && <Composer runId={runId} entityVersion={entityVersion} />}
      </section>

      <aside className="line-scroll" aria-label={t("team.line.title")}>
        <div className="line">
          <div className="line-head"><h2>{t("team.line.title")}</h2></div>
          <div className="line-body">
            {tasks.map(task => <TaskRow key={task.qitemId} task={task} seats={read?.seats ?? []} onOpen={() => onOpenTask(task.taskId)} />)}
          </div>
          <MergePlate read={read} remaining={remaining} integration={integration.data} onOpenBranch={onOpenBranch} now={now} />
        </div>
      </aside>
    </main>
  </>;
}

function activeName(tasks: readonly TeamReviewView[], t: TFunction): string | null {
  const activeTask = tasks.find(task => !isFinished(task) && stateOf(task) !== "queued") ?? tasks.find(task => !isFinished(task));
  return activeTask ? `${taskName(activeTask, t)} · ${stateLabel(stateOf(activeTask), t)}` : null;
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

function Composer({ runId, entityVersion }: { runId: string; entityVersion: number }) {
  const { t } = useTranslation();
  const { request } = useOwnerSession();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  return <form className="composer" onSubmit={async event => {
    event.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true);
    try { await sendChatMessage(request, runId, body.trim(), entityVersion); setBody(""); } finally { setBusy(false); }
  }}>
    <textarea rows={1} aria-label={t("team.chat.message")} value={body} onChange={event => setBody(event.target.value)} />
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

function TaskRow({ task, seats, onOpen }: { task: TeamReviewView; seats: TeamOwnerRead["seats"]; onOpen: () => void }) {
  const { t } = useTranslation();
  const state = stateOf(task);
  return <button className="task" data-state={state} onClick={onOpen}>
    <span className="node" aria-hidden="true" />
    <span><span className="task-name">{taskName(task, t)}</span><span className="task-seat">{seatLabel(task.role, seats, t)}</span></span>
    <span className="task-state">{stateLabel(state, t)}</span>
  </button>;
}

/** The line's terminus. Open until U7 says the branch can merge — the gate is the point. */
function MergePlate({ read, remaining, integration, onOpenBranch }: {
  read?: TeamOwnerRead; remaining: number; integration?: IntegrationState; onOpenBranch: () => void; now: number;
}) {
  const { t } = useTranslation();
  const { request } = useOwnerSession();
  const [busy, setBusy] = useState(false);
  const available = integration?.available === true;
  const canMerge = available && integration!.merge.possible && remaining === 0;
  const state = remaining > 0 ? t("team.line.waitingOn", { count: remaining })
    : !available ? t("team.merge.unavailable")
      : canMerge ? t("team.merge.ready", { count: integration!.commits.length })
        : t("team.merge.blocked");
  return <div className="merge" data-ready={canMerge ? "true" : "false"}>
    <h3 className="mono" style={{ fontSize: 14, fontWeight: 500 }}>{readableBranch(integration?.branch ?? "") || (read ? branchName(read.run.displayName) : t("team.branch.title"))}</h3>
    <p>{state}</p>
    <button className="btn btn-outline" disabled={!canMerge || busy} onClick={async () => {
      if (!read || !canMerge) return;
      setBusy(true);
      try { await mergeBranch(request, read.runId, read.run.entityVersion); } finally { setBusy(false); }
    }}>{t("team.merge.action")}</button>
    <button className="merge-link" onClick={onOpenBranch}>{t("team.branch.title")}<ChevronRight /></button>
  </div>;
}