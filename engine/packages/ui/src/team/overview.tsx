import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TeamOwnerRead, TeamReviewView } from "@openrig/daemon/team-control";
import { ArrowRight, GitMerge } from "lucide-react";
import { useOwnerSession } from "../hooks/useOwnerSession.js";
import { mergeBranch, type ChatState, type IntegrationState } from "./clients.js";
import { pendingOwnerDecisions, ResumePlate } from "./chat-panel.js";
import { assignedSeat, namedSeat, TASK_STAGE_LABELS, taskName } from "./display.js";
import { useRunTokens } from "./hooks.js";
import { TaskProgress } from "./task-progress.js";
import { TaskTimeline } from "./task-drawer.js";

export function verifiedChecks(tasks: readonly TeamReviewView[]): { verified: number; total: number } | null {
  if (tasks.length === 0 || tasks.some(task => task.criteria.verified === null || task.criteria.total === null)) return null;
  return tasks.reduce((sum, task) => ({ verified: sum.verified + task.criteria.verified!, total: sum.total + task.criteria.total! }),
    { verified: 0, total: 0 });
}

function Progress({ read, integration }: { read?: TeamOwnerRead; integration?: IntegrationState }) {
  const { t } = useTranslation();
  const tasks = read?.tasks ?? [];
  const checks = verifiedChecks(tasks);
  const planning = read?.run.phase === "planning";
  const building = tasks.some(task => task.role !== "reviewer" && !["review", "done"].includes(task.stage));
  const reviewing = tasks.some(task => task.stage === "review" || (task.role === "reviewer" && task.stage !== "done"));
  const phases = [
    { label: "progress.plan", state: planning ? "active" : "complete" },
    { label: "progress.build", state: planning ? "pending" : building ? "active" : tasks.length ? "complete" : "pending" },
    { label: "progress.review", state: planning || tasks.length === 0 ? "pending" : reviewing ? "active" : integration?.tasksDone ? "complete" : "pending" },
    { label: "progress.merge", state: integration?.merge.possible ? "awaiting-decision" : "pending" },
  ] as const;
  return <section className="ui-card ui-progress" aria-label={t("overview.progress")}>
    <div className="ui-progress-head"><h2>{t("overview.progress")}</h2>
      <span className="ui-muted">{checks ? t("overview.verified", checks) : t("overview.verifiedUnknown")}</span></div>
    <ol className="ui-phase-strip">{phases.map(phase => <li key={phase.label} data-state={read ? phase.state : "unavailable"}>
      <span className="ui-dot" aria-hidden="true" /><strong>{t(phase.label)}</strong>
      <small>{t(("web.stageState." + (read ? phase.state : "unavailable")) as "web.stageState.pending")}</small>
    </li>)}</ol>
  </section>;
}

function RunActions({ read, integration }: { read?: TeamOwnerRead; integration?: IntegrationState }) {
  const { t } = useTranslation();
  const { request } = useOwnerSession();
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const closed = read?.run.state === "canceled" || read?.run.state === "cancel_requested";
  const canMerge = !!read && !closed && integration?.available === true && integration.merge.possible;
  const act = async (action: "merge" | "cancel") => {
    if (!read || busy || (action === "merge" && !canMerge)) return;
    if (!window.confirm(t(action === "merge" ? "overview.mergeConsequence" : "team.cancelPrompt"))) return;
    setBusy(true); setMessage(null);
    try {
      if (action === "merge") {
        const result = await mergeBranch(request, read.runId, read.run.entityVersion);
        const code = result.code;
        const knownCode = ["merge_tasks_open", "merge_checkout_dirty", "merge_detached_head",
          "merge_already_on_branch", "merge_no_branch", "merge_unavailable"].includes(code ?? "");
        setMessage({ error: result.status !== "merged", text: result.status === "merged" ? t("team.merge.done")
          : result.status === "conflict" ? t("team.merge.conflict")
            : knownCode ? t(("team.merge.refused." + code) as "team.merge.refused.merge_unavailable") : t("team.merge.blocked") });
      } else {
        const result = await request<{ status: string; value?: { state?: string } }>("/runs/" + encodeURIComponent(read.runId) + "/cancel", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ protocolVersion: "1.0", runId: read.runId, actionId: crypto.randomUUID(),
            expectedEntityVersion: read.run.entityVersion, idempotencyKey: crypto.randomUUID(),
            payload: { reason: "Owner canceled the run" } }),
        });
        if (result.status === "denied") throw new Error("Cancellation denied");
        setMessage({ error: false, text: t(result.value?.state === "canceled"
          ? "status.run.canceled" : "status.run.cancel_requested") });
      }
      await cache.invalidateQueries({ queryKey: ["team", read.runId] });
    } catch { setMessage({ error: true, text: t("web.error") }); }
    finally { setBusy(false); }
  };
  return <div className="ui-run-actions">
    <div className="ui-page-actions">
      <button className="btn btn-outline" disabled={!read || closed || busy} onClick={() => void act("cancel")}>{t("action.cancel")}</button>
      <button className="btn btn-primary" disabled={!canMerge || busy} onClick={() => void act("merge")}><GitMerge aria-hidden="true" />{t("team.merge.action")}</button>
    </div>
    {!canMerge && <small className="ui-muted">{t(integration?.available ? "team.merge.blocked" : "team.merge.unavailable")}</small>}
    {message && <p role={message.error ? "alert" : "status"}>{message.text}</p>}
  </div>;
}

/** Restored panels share the daemon stage and the chat's exact owner-decision list. */
export function Overview({ read, chat, integration, onOpenTasks, onOpenTask, onOpenChat }: {
  read?: TeamOwnerRead; chat?: ChatState; integration?: IntegrationState;
  onOpenTasks: () => void; onOpenTask: (taskId: string) => void; onOpenChat: (opener: HTMLButtonElement) => void;
}) {
  const { t, i18n } = useTranslation();
  const tokens = useRunTokens(read);
  const tasks = read?.tasks ?? [];
  const active = tasks.filter(task => task.stage !== "done");
  const decisions = pendingOwnerDecisions(read, chat);
  const fleet = (read?.seats ?? []).filter(seat => !seat.retired).map(seat => ({
    seat, attempt: read?.attempts.filter(attempt => attempt.session === seat.seat).at(-1),
  }));
  const summary = [
    { label: "overview.agentsActive", value: read ? fleet.filter(item => item.attempt?.state === "running").length : "—" },
    { label: "overview.tasks", value: read ? tasks.length : "—" },
    { label: "overview.blocked", value: read ? tasks.filter(task => task.stage === "owner/blocked" || task.stage === "lead/report").length : "—" },
    { label: "overview.tokens", value: tokens.tokens === null ? "—"
      : new Intl.NumberFormat(i18n.resolvedLanguage, { notation: "compact", maximumFractionDigits: 1 }).format(tokens.tokens) },
  ] as const;
  return <main className="ui-screen ui-overview">
    <header className="ui-page-head">
      <div><h1>{t("nav.overview")}</h1><p className="ui-subtitle">{read?.run.displayName ?? t("value.unavailable")}</p></div>
      <RunActions read={read} integration={integration} />
    </header>
    <section className="ui-card ui-summary" aria-label={t("overview.summary")}><dl>{summary.map(cell => <div key={cell.label}>
      <dt>{t(cell.label)}</dt><dd>{cell.value}</dd>
      {cell.label === "overview.tokens" && <small className="ui-muted">{t(tokens.partial && tokens.tokens !== null ? "overview.partialTokens" : "overview.nativeTokens")}</small>}
    </div>)}</dl></section>
    <Progress read={read} integration={integration} />
    <div className={"ui-overview-grid" + (decisions.length ? "" : " ui-overview-grid-solo")}>
      <section className="ui-card" aria-label={t("overview.activeTasks")}>
        <div className="ui-section-head"><h2>{t("overview.activeTasks")}<span className="ui-count">{active.length}</span></h2>
          <button className="btn btn-quiet" onClick={onOpenTasks}>{t("overview.viewAllTasks")}<ArrowRight aria-hidden="true" /></button></div>
        {!read ? <p className="ui-muted">{t("value.unavailable")}</p>
          : active.length === 0 ? <p className="ui-muted">{t("tasks.empty")}</p>
            : <ul className="ui-active-list">{active.map(task => <li key={task.taskId}>
              <button onClick={() => onOpenTask(task.taskId)}>
                <span><strong>{taskName(task, t)}</strong><small>{assignedSeat(task, read.seats, t)}</small></span>
                <span className="ui-stage" data-stage={task.stage}>{t(TASK_STAGE_LABELS[task.stage])}</span>
                <TaskProgress task={task} />
              </button>
            </li>)}</ul>}
      </section>
      {decisions.length > 0 && <section className="ui-card ui-attention-card" aria-label={t("overview.needsAttention")}>
        <h2>{t("overview.needsAttention")}<span className="ui-count">{decisions.length}</span></h2>
        <ul className="ui-attention-list">{decisions.map(decision => <li key={decision.kind === "message" ? decision.message.id : decision.kind}>
          {decision.kind === "resume" ? <ResumePlate read={read!} /> : <>
            <strong>{decision.kind === "plan" ? t("overview.planApproval") : decision.message.body}</strong>
            <p className="ui-muted">{t("tasks.stage.owner")}</p>
            <button className="btn btn-outline" onClick={event => onOpenChat(event.currentTarget)}>
              {t(decision.kind === "plan" ? "overview.reviewPlan" : "overview.answerLead")}<ArrowRight aria-hidden="true" />
            </button>
          </>}
        </li>)}</ul>
      </section>}
    </div>
    <div className="ui-overview-foot">
      <section className="ui-card" aria-label={t("overview.fleet")}><h2>{t("overview.fleet")}<span className="ui-count">{fleet.length}</span></h2>
        {!read ? <p className="ui-muted">{t("value.unavailable")}</p>
          : <ul className="ui-fleet-list">{fleet.map(({ seat, attempt }) => <li key={seat.seat}>
            <span className="ui-dot" data-state={attempt?.state ?? "idle"} aria-hidden="true" />
            {seat.role === "lead" ? <button className="ui-text-button" onClick={event => onOpenChat(event.currentTarget)}>{namedSeat(seat, t)}</button>
              : <strong>{namedSeat(seat, t)}</strong>}
            <span className="ui-muted">{attempt ? t(("status.attempt." + attempt.state) as "status.attempt.running") : t("shell.idle")}</span>
          </li>)}</ul>}
      </section>
      <section className="ui-card" aria-label={t("overview.recentEvents")}><h2>{t("overview.recentEvents")}</h2>
        <TaskTimeline logs={[...(read?.logs ?? [])].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 4)} tasks={tasks} />
      </section>
    </div>
    {integration?.available && integration.commits.length > 0 && <section className="ui-card" aria-label={t("team.branch.title")}>
      <h2>{t("team.branch.title")}</h2>
      <details className="ui-integration-history"><summary>{t("overview.integrationHistory", { count: integration.commits.length })}</summary>
        <ol>{integration.commits.map(commit => {
          const task = tasks.find(task => task.taskId === commit.task);
          return <li key={commit.hash + ":" + commit.task}>
            {task ? <button className="ui-text-button" onClick={() => onOpenTask(task.taskId)}>{taskName(task, t)}</button> : <span>{commit.subject}</span>}
            <code>{commit.hash}</code>
          </li>;
        })}</ol>
      </details>
    </section>}
  </main>;
}
