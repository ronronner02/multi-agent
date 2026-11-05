import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TeamOwnerRead, TeamReviewView } from "@openrig/daemon/team-control";
import type { TFunction } from "i18next";
import { useOwnerSession } from "../hooks/useOwnerSession.js";
import { approvePlan, mergeBranch, sendChatMessage } from "./clients.js";
import { isFinished, seatLabel, stateLabel, stateOf, taskName } from "./display.js";
import { Check, ChevronRight } from "./glyphs.js";
import { useBranch, useTeamChat } from "./hooks.js";

/**
 * U10 — the run home.
 *
 * The lead's conversation is the protagonist. Beside it the run's tasks are drawn as one line
 * that ends at the merge plate, which is disabled until every task is finished. Decisions the
 * lead needs arrive as plates in the record; until U5 lands, the plan plate is built from the
 * owner read's own approval record, so the screen is never empty of the thing it is for.
 */
export function RunHome({ read, runId, available, now, onOpenTask, onOpenBranch }: {
  read?: TeamOwnerRead; runId: string; available: boolean; now: number;
  onOpenTask: (taskId: string) => void; onOpenBranch: () => void;
}) {
  const { t } = useTranslation();
  const chat = useTeamChat(runId, available);
  const branch = useBranch(runId, available);
  const tasks = read?.tasks ?? [];
  const finished = tasks.length > 0 && tasks.every(isFinished);
  const remaining = tasks.filter(task => !isFinished(task)).length;

  const plane = <PlanPlate read={read} runId={runId} />;
  const blocked = read?.run.state === "blocked" ? <ResumePlate read={read} /> : null;

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
            ? chat.data.messages.map(message => <Turn key={message.id} author={message.author} seat={message.seat ?? null}
              body={message.body} />)
            : plane}
          {chat.data?.available && plane}
          {blocked}
          {chat.data && !chat.data.available && <p className="muted" style={{ fontSize: 13 }}>{t("team.chat.unavailable")}</p>}
        </div>
        {chat.data?.available && <Composer runId={runId} />}
      </section>

      <aside className="line-scroll" aria-label={t("team.line.title")}>
        <div className="line">
          <div className="line-head"><h2>{t("team.line.title")}</h2></div>
          <div className="line-body">
            {tasks.map(task => <TaskRow key={task.qitemId} task={task} seats={read?.seats ?? []} onOpen={() => onOpenTask(task.taskId)} />)}
          </div>
          <MergePlate runId={runId} read={read} finished={finished} remaining={remaining}
            commits={branch.data?.commits.length ?? 0} available={branch.data?.available ?? false} onOpenBranch={onOpenBranch} now={now} />
        </div>
      </aside>
    </main>
  </>;
}

function activeName(tasks: readonly TeamReviewView[], t: TFunction): string | null {
  const activeTask = tasks.find(task => !isFinished(task) && stateOf(task) !== "queued") ?? tasks.find(task => !isFinished(task));
  return activeTask ? `${taskName(activeTask, t)} · ${stateLabel(stateOf(activeTask), t)}` : null;
}

function Turn({ author, seat, body }: { author: "owner" | "lead"; seat: string | null; body: string }) {
  const { t } = useTranslation();
  return <div className={author === "owner" ? "turn turn-owner" : "turn"}>
    <div className="turn-who">{author === "owner" ? t("team.chat.you") : t("role.lead")}{seat ? <span className="seat">{seat}</span> : null}</div>
    <p className="turn-body">{body}</p>
  </div>;
}

/** The composer is quiet until it has something to say: one filled accent per state. */
function Composer({ runId }: { runId: string }) {
  const { t } = useTranslation();
  const { request } = useOwnerSession();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  return <form className="composer" onSubmit={async event => {
    event.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true);
    try { await sendChatMessage(request, runId, body.trim()); setBody(""); } finally { setBusy(false); }
  }}>
    <textarea rows={1} aria-label={t("team.chat.message")} value={body} onChange={event => setBody(event.target.value)} />
    <button className="btn btn-primary" type="submit" disabled={busy || !body.trim()}>{t("team.chat.send")}</button>
  </form>;
}

/**
 * The plan, as the record's first plate. Its task list is the work the read publishes, so what
 * the owner approves is what the team was given. Approval goes through the control surface's
 * own approval record until U5's `plan/approve` route exists.
 */
function PlanPlate({ read, runId }: { read?: TeamOwnerRead; runId: string }) {
  const { t } = useTranslation();
  const { request } = useOwnerSession();
  const [busy, setBusy] = useState(false);
  const approval = read?.approvals.find(item => item.action === "implementation") ?? null;
  const approved = approval ? approval.state === "approved" : read?.run.state === "approved";
  const work = useMemo(() => (read?.tasks ?? []).filter(task => task.role !== "reviewer").slice(0, 5), [read]);
  if (!read) return null;

  const approve = async () => {
    if (!approval || busy) return;
    setBusy(true);
    try {
      await approvePlan(request, runId);
    } catch {
      // U5's route is not on this branch: fall back to the control surface's approval decision.
      await request(`/runs/${encodeURIComponent(runId)}/approvals/decide`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protocolVersion: "1.0", runId, actionId: approval.id,
          expectedEntityVersion: read.run.entityVersion, idempotencyKey: crypto.randomUUID(),
          payload: { approvalVersion: approval.entityVersion, decision: "approved" } }),
      });
    } finally { setBusy(false); }
  };

  return <div className={approved ? "plate" : "plate plate-waiting"} role="group" aria-label={t("team.plan.approve")}>
    <h2 className="plate-title">{read.run.displayName}</h2>
    <div className="plate-meta">{t("team.plan.work", { count: work.length })}</div>
    <ol className="plate-list">
      {work.map((task, index) => <li key={task.qitemId}>
        <span className="n">{String(index + 1).padStart(2, "0")}</span>
        <span>{taskName(task, t)}</span>
        <span className="st">{seatLabel(task.role, read.seats, t)}</span>
      </li>)}
    </ol>
    <div className="plate-foot">
      {approved ? <span className="plate-done"><Check />{t("team.plan.approvedShort")}</span>
        : <><button className="btn btn-primary" disabled={busy || !approval} onClick={() => void approve()}>{t("team.plan.approve")}</button></>}
    </div>
  </div>;
}

/**
 * U8 — a blocked run's one owner action.
 *
 * The daemon publishes a stable label key for the block, so the plate says why in the reader's
 * language. A budget block cannot be resumed without raising that budget, so the same click
 * raises it by the amount the run already had: a resumable budget is a decision with a value,
 * and the plate states the value before it is taken.
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

/** The line's terminus. Disabled until every task is finished — the gate is the point. */
function MergePlate({ read, finished, remaining, commits, available, onOpenBranch }: {
  runId: string; read?: TeamOwnerRead; finished: boolean; remaining: number; commits: number; available: boolean;
  onOpenBranch: () => void; now: number;
}) {
  const { t } = useTranslation();
  const { request } = useOwnerSession();
  const [busy, setBusy] = useState(false);
  // U7 publishes the branch and its target; until it lands the target is the repository's
  // default branch, which is what this daemon's own merge will name.
  const target = "main";
  const canMerge = finished && available;
  return <div className="merge" data-ready={canMerge ? "true" : "false"}>
    <h3>{t("team.merge.title", { branch: target })}</h3>
    <p>{finished ? (available ? t("team.merge.ready", { count: commits }) : t("team.merge.unavailable"))
      : t("team.line.waitingOn", { count: remaining })}</p>
    <button className="btn btn-outline" disabled={!canMerge || busy} onClick={async () => {
      if (!read || !canMerge) return;
      setBusy(true);
      try { await mergeBranch(request, read.runId); } finally { setBusy(false); }
    }}>{t("team.merge.action")}</button>
    <button className="merge-link" onClick={onOpenBranch}>{t("team.branch.title")}<ChevronRight /></button>
  </div>;
}