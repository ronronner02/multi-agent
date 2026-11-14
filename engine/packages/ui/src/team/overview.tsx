import { TextPreview } from "./text-preview.js";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TeamOwnerRead, TeamReviewView, TeamSystemHealth } from "@multi-agent/daemon/team-control";
import { TEAM_HEALTH_LIGHTS } from "../../../daemon/dist/contracts/team-control.js";
import { ArrowRight, ArrowUpRight, GitMerge } from "lucide-react";
import { useOwnerSession } from "../hooks/useOwnerSession.js";
import { usePendingAction } from "../hooks/usePendingAction.js";
import { cancelRun, mergeBranch, type ChatState, type IntegrationState } from "./clients.js";
import { pendingOwnerDecisions, pendingWorkerQuestions, QuestionPlate, ResumePlate } from "./chat-panel.js";
import { clockTime, namedSeat, taskName } from "./display.js";
import { useRunTokens } from "./hooks.js";
import { TaskWorkbench } from "./task-workbench.js";
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
    { label: "progress.merge", state: integration?.available && (integration.merge.merged === true || integration.pullRequest?.state === "merged")
      ? "complete" : integration?.merge.possible ? "awaiting-decision" : "pending" },
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
  const pending = usePendingAction(`${read?.runId}:${read?.run.entityVersion}:${integration?.merge.merged}`);
  const { busy } = pending;
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const closed = read?.run.state === "canceled" || read?.run.state === "cancel_requested";
  // Plan R17 — a GitHub project's run is merged as its open pull request, on GitHub, with the owner's account.
  const pull = integration?.available ? integration.pullRequest ?? null : null;
  const viaPull = pull?.state === "open" ? pull : null;
  const merged = integration?.available === true && (integration.merge.merged === true || pull?.state === "merged");
  const canMerge = !!read && !closed && !merged && integration?.available === true && integration.merge.possible;
  const act = async (action: "merge" | "cancel") => {
    if (!read || busy || (action === "merge" && !canMerge)) return;
    const prompt = action === "cancel" ? t("team.cancelPrompt")
      : viaPull ? t("overview.mergePullRequestConsequence", { number: viaPull.number }) : t("overview.mergeConsequence");
    if (!window.confirm(prompt)) return;
    if (!pending.begin()) return;
    setMessage(null);
    let accepted = true;
    try {
      if (action === "merge") {
        const result = await mergeBranch(request, read.runId, read.run.entityVersion);
        const code = result.code;
        accepted = result.status === "merged";
        const knownCode = ["merge_tasks_open", "merge_checkout_dirty", "merge_detached_head",
          "merge_already_on_branch", "merge_no_branch", "merge_unavailable",
          "github_pr_failed", "github_network_failure", "github_not_signed_in"].includes(code ?? "");
        setMessage({ error: result.status !== "merged", text: result.status === "merged" ? t("team.merge.done")
          : result.status === "conflict" ? t("team.merge.conflict")
            : knownCode ? t(("team.merge.refused." + code) as "team.merge.refused.merge_unavailable") : t("team.merge.blocked") });
      } else {
        const result = await cancelRun(request, read.runId, read.run.entityVersion);
        if (result.status === "denied") throw new Error("Cancellation denied");
        setMessage({ error: false, text: t(result.value?.state === "canceled"
          ? "status.run.canceled" : "status.run.cancel_requested") });
      }
      await cache.invalidateQueries({ queryKey: ["team", read.runId] });
      if (accepted) pending.complete(); else pending.fail();
    } catch { setMessage({ error: true, text: t("web.error") }); pending.fail(); }
  };
  return <div className="ui-run-actions">
    <div className="ui-page-actions">
      <button className="btn btn-outline" disabled={!read || closed || busy} onClick={() => void act("cancel")}>{t("action.cancel")}</button>
      {pull && <a className="btn btn-outline" href={pull.url} target="_blank" rel="noopener noreferrer">
        <ArrowUpRight aria-hidden="true" />{t("team.pullRequest.link", { number: pull.number })}</a>}
      <button className="btn btn-primary" disabled={!canMerge || busy} onClick={() => void act("merge")}><GitMerge aria-hidden="true" />
        {merged ? t("team.merge.done") : viaPull ? t("team.merge.pullRequest", { number: viaPull.number }) : t("team.merge.action")}</button>
    </div>
    {!canMerge && !merged && <small className="ui-muted">{t(integration?.available ? "team.merge.blocked" : "team.merge.unavailable")}</small>}
    {message && <p role={message.error ? "alert" : "status"}>{message.text}</p>}
  </div>;
}

function SystemStatus({ health }: { health?: TeamSystemHealth }) {
  const { t } = useTranslation();
  return <section className="ui-card ui-system-status" aria-label={t("overview.systemStatus")}>
    <h2>{t("overview.systemStatus")}</h2>
    <ul>{TEAM_HEALTH_LIGHTS.map(name => {
      const light = health?.lights[name];
      const state = light?.state ?? "unknown";
      return <li key={name}><span className="ui-dot" data-state={state} aria-hidden="true" />
        <details><summary><span>{t(`web.health.${name}`)}</span><strong>{t(`web.health.${state}`)}</strong></summary>
          <p>{light?.reason ?? t("value.unavailable")}</p>
          {light?.checkedAt && <time dateTime={light.checkedAt}>{clockTime(light.checkedAt)}</time>}
        </details>
      </li>;
    })}</ul>
  </section>;
}

/** Restored panels share the daemon stage and the chat's exact owner-decision list. */
export function Overview({ read, chat, integration, health, onOpenTasks, onOpenTask, onOpenChat, onOpenWorkspace, onOpenReviews }: {
  read?: TeamOwnerRead; chat?: ChatState; integration?: IntegrationState; health?: TeamSystemHealth;
  onOpenWorkspace?: (taskId: string) => void; onOpenReviews?: (taskId: string) => void;
  onOpenTasks: () => void; onOpenTask: (taskId: string) => void; onOpenChat: (opener: HTMLButtonElement) => void;
}) {
  const { t, i18n } = useTranslation();
  const tokens = useRunTokens(read);
  const tasks = read?.tasks ?? [];
  const [selection, setSelection] = useState<{ runId: string; taskId: string }>();
  const decisions = pendingOwnerDecisions(read, chat);
  const questions = pendingWorkerQuestions(read);
  const fleet = (read?.seats ?? []).filter(seat => !seat.retired).map(seat => ({
    seat, attempt: read?.attempts.filter(attempt => attempt.session === seat.seat).at(-1),
  }));
  const summary = [
    { label: "overview.agentsActive", value: read ? fleet.filter(item => item.attempt?.state === "running").length : "—" },
    { label: "overview.tasks", value: read ? tasks.length : "—" },
    { label: "overview.blocked", value: read ? tasks.filter(task => task.stage === "owner/blocked" || task.stage === "owner/question" || task.stage === "lead/report").length : "—" },
    { label: "overview.tokens", value: tokens.tokens === null ? "—"
      : new Intl.NumberFormat(i18n.resolvedLanguage, { notation: "compact", maximumFractionDigits: 1 }).format(tokens.tokens) },
  ] as const;
  return <main className="ui-screen ui-overview">
    <header className="ui-page-head ui-command-hero">
      <div><h1>{t("nav.overview")}</h1><div className="ui-subtitle"><TextPreview text={read?.run.displayName ?? t("value.unavailable")} /></div></div>
      <RunActions key={read?.runId} read={read} integration={integration} />
    </header>
    <div className="ui-command-summary">
    <section className="ui-card ui-summary" aria-label={t("overview.summary")}><dl>{summary.map(cell => <div key={cell.label}>
      <dt>{t(cell.label)}</dt><dd>{cell.value}</dd>
      {cell.label === "overview.tokens" && <small className="ui-muted">{t(tokens.partial && tokens.tokens !== null ? "overview.partialTokens" : "overview.nativeTokens")}</small>}
    </div>)}</dl></section>
    <Progress read={read} integration={integration} />
    </div>
      {decisions.length + questions.length > 0 && <section className="ui-card ui-attention-card" aria-label={t("overview.needsAttention")}>
        <h2>{t("overview.needsAttention")}<span className="ui-count">{decisions.length + questions.length}</span></h2>
        <ul className="ui-attention-list">{questions.map(task => <li key={"question:" + task.taskId}><QuestionPlate read={read!} task={task} /></li>)}
          {decisions.map(decision => <li key={decision.kind === "message" ? decision.message.id : decision.kind}>
          {decision.kind === "resume" ? <ResumePlate read={read!} /> : <>
            <TextPreview text={decision.kind === "plan" ? t("overview.planApproval") : decision.message.body} />
            <p className="ui-muted">{t("tasks.stage.owner")}</p>
            <button className="btn btn-outline" onClick={event => onOpenChat(event.currentTarget)}>
              {t(decision.kind === "plan" ? "overview.reviewPlan" : "overview.answerLead")}<ArrowRight aria-hidden="true" />
            </button>
          </>}
        </li>)}</ul>
      </section>}
      {read ? <TaskWorkbench key={read.runId} read={read} initialFilter={tasks.some(task => task.stage !== "done") ? "active" : "all"}
        selectedTaskId={selection?.runId === read.runId ? selection.taskId : ""}
        onSelect={taskId => setSelection({ runId: read.runId, taskId })}
        onOpenAll={onOpenTasks} onOpenTask={onOpenTask} onOpenWorkspace={onOpenWorkspace} onOpenReviews={onOpenReviews} />
        : <section className="ui-card"><p className="ui-muted">{t("value.unavailable")}</p></section>}
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
    <aside className="ui-system-rail">
      <section className="ui-card" aria-label={t("overview.fleet")}><h2>{t("overview.fleet")}<span className="ui-count">{fleet.length}</span></h2>
        {!read ? <p className="ui-muted">{t("value.unavailable")}</p>
          : <ul className="ui-fleet-list">{fleet.map(({ seat, attempt }) => <li key={seat.seat}>
            <span className="ui-dot" data-state={attempt?.state ?? "idle"} aria-hidden="true" />
            {seat.role === "lead" ? <button className="ui-text-button" onClick={event => onOpenChat(event.currentTarget)}>{namedSeat(seat, t)}</button>
              : <strong>{namedSeat(seat, t)}</strong>}
            <span className="ui-muted">{attempt ? t(("status.attempt." + attempt.state) as "status.attempt.running") : t("shell.idle")}</span>
          </li>)}</ul>}
      </section>
      <SystemStatus health={health} />
      <section className="ui-card" aria-label={t("overview.recentEvents")}><h2>{t("overview.recentEvents")}</h2>
        <TaskTimeline logs={[...(read?.logs ?? [])].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 4)} tasks={tasks} />
      </section>
    </aside>
  </main>;
}
