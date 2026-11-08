import { TextPreview } from "./text-preview.js";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { RefObject } from "react";
import type { TeamOwnerRead, TeamReviewView } from "@openrig/daemon/team-control";
import { assignedSeat, clockTime, TASK_STAGE_LABELS, taskName } from "./display.js";
import { TaskProgress } from "./task-progress.js";

export function TaskTimeline({ logs, tasks }: { logs: TeamOwnerRead["logs"]; tasks: readonly TeamReviewView[] }) {
  const { t } = useTranslation();
  return logs.length === 0 ? <p className="ui-muted">{t("web.noEvents")}</p>
    : <ol className="ui-event-list">{logs.map((log, index) => {
      const task = tasks.find(item => item.taskId === log.taskId);
      return <li key={log.streamItemId ?? log.ts + ":" + index}>
        <time dateTime={log.ts}>{clockTime(log.ts)}</time>
        <div><TextPreview text={task ? taskName(task, t) : t("overview.runEvent")} />
          <details><summary>{t(("tasks.event." + log.source) as "tasks.event.stream")}</summary>
            <pre>{log.body}</pre>{log.truncated && <small>{t("web.truncated")}</small>}
          </details>
        </div>
      </li>;
    })}</ol>;
}

export function TaskDetails({ read, task }: { read?: TeamOwnerRead; task: TeamReviewView }) {
  const { t } = useTranslation();
  const attempts = read?.attempts.filter(attempt => attempt.taskId === task?.taskId) ?? [];
  const logs = read?.logs.filter(log => log.taskId === task?.taskId).slice().reverse() ?? [];
  const report = task?.workerReport;
  return <div className="ui-drawer-body">
  <p className="ui-muted">{assignedSeat(task, read?.seats ?? [], t)}</p>
  {task.description && <section><h3>{t("tasks.description")}</h3>
    <div className="ui-task-brief"><TextPreview text={task.description.body} /></div>
    {task.description.truncated && <small className="ui-muted">{t("web.truncated")}</small>}
  </section>}
  <section><h3>{t("tasks.declaredAcceptance")}</h3>
    {task.declaredAcceptanceCriteria ? <>
      <div className="ui-task-brief"><TextPreview text={task.declaredAcceptanceCriteria.body || t("tasks.noDeclaredAcceptance")} /></div>
      {task.declaredAcceptanceCriteria.truncated && <small className="ui-muted">{t("web.truncated")}</small>}
    </> : <p className="ui-muted">{t("tasks.noDeclaredAcceptance")}</p>}
  </section>
  <section><h3>{t("nav.workspace")}</h3>
    {task.workspace ? <dl className="ui-task-location">
      <dt>{t("tasks.worktree")}</dt><dd><code>{task.workspace.root}</code></dd>
      <dt>{t("tasks.sourceWorkspace")}</dt><dd><code>{task.workspace.sourceRoot}</code></dd>
      {task.workspace.baseCommit && <><dt>{t("tasks.baseCommit")}</dt><dd><code>{task.workspace.baseCommit}</code></dd></>}
    </dl> : <p className="ui-muted">{t("tasks.noWorkspace")}</p>}
    {task.integrationBranch && <dl className="ui-task-location"><dt>{t("tasks.integrationBranch")}</dt><dd><code>{task.integrationBranch}</code></dd></dl>}
  </section>
  <section><h3>{t("overview.progress")}</h3><TaskProgress task={task} /></section>
  <section><h3>{t("tasks.dependencies")}</h3>
    {task.dependencies === null ? <p className="ui-muted">{t("value.unavailable")}</p>
      : task.dependencies.length === 0 ? <p className="ui-muted">{t("tasks.noDependencies")}</p>
        : <ul>{task.dependencies.map(id => {
          const dependency = read?.tasks.find(item => item.taskId === id);
          return <li key={id}>{dependency ? taskName(dependency, t) : t("value.unavailable")}</li>;
        })}</ul>}
  </section>
  <section><h3>{t("tasks.workerReport")}</h3>
    {!report ? <p className="ui-muted">{t("tasks.noReport")}</p> : <>
      <p>{t(("tasks.report." + report.status) as "tasks.report.blocked")}</p>
      {report.question && <p>{report.question}</p>}
      {report.resolution && <p>{t(("tasks.resolution." + report.resolution) as "tasks.resolution.rework")}</p>}
      <details><summary>{t("tasks.reportEvidence")}</summary><pre>{report.evidence}</pre>
        {report.truncated && <small>{t("web.truncated")}</small>}
      </details>
    </>}
  </section>
  <section><h3>{t("team.task.attempts")}</h3>
    {attempts.length === 0 ? <p className="ui-muted">{t("web.noAttempts")}</p>
      : <ol className="ui-attempt-list">{attempts.map((attempt, index) => <li key={attempt.attemptId}>
        <span>{t("team.task.attemptN", { round: index + 1 })}</span>
        <span>{t(("status.attempt." + attempt.state) as "status.attempt.running")}</span>
        <small>{t(attempt.provider === "codex" ? "team.client.codex" : "team.client.claude-code")}</small>
        {attempt.failure && <details><summary>{t("tasks.failureDetails")}</summary>
          <p>{attempt.failure.ownerAction}</p><code>{attempt.failure.reasonCode}</code>
        </details>}
      </li>)}</ol>}
  </section>
  <section><h3>{t("team.task.review")}</h3>
    {task.verdicts.length === 0 ? <p className="ui-muted">{t("team.task.noReview")}</p>
      : <ol className="ui-verdict-list">{task.verdicts.map(verdict => <li key={verdict.round}>
        <strong>{t(("team.task.verdict." + verdict.verdict) as "team.task.verdict.approved")}</strong>
        <span>{t("team.task.roundN", { round: verdict.round })} · {t("team.task.findingCount", { count: verdict.findings })}</span>
        {verdict.blocking > 0 && <span>{t("team.task.blockingCount", { count: verdict.blocking })}</span>}
      </li>)}</ol>}
  </section>
  <section><h3>{t("tasks.timeline")}</h3><TaskTimeline logs={logs} tasks={read?.tasks ?? []} /></section>
  <details className="ui-technical-details"><summary>{t("tasks.technicalDetails")}</summary>
    <dl><dt>{t("overview.colState")}</dt><dd>{t(("status.queue." + task.queueState) as "status.queue.done")}</dd>
      <dt>{t("tasks.rawTask")}</dt><dd>{task.taskId}</dd><dt>{t("tasks.rawQueue")}</dt><dd>{task.qitemId}</dd>
      <dt>{t("tasks.rawSeat")}</dt><dd>{task.seat ?? "—"}</dd><dt>{t("tasks.dependencies")}</dt><dd>{task.dependencies?.join(", ") ?? "—"}</dd>
      <dt>{t("tasks.rawCandidate")}</dt><dd>{task.currentCandidateDigest ?? "—"}</dd>
      {attempts.map(attempt => <div key={attempt.attemptId}><dt>{t("tasks.rawAttempt")}</dt><dd>{attempt.attemptId}</dd></div>)}
    </dl>
  </details>
</div>;
}

export function TaskDrawer({ read, task, onClose, opener }: {
  read?: TeamOwnerRead; task?: TeamReviewView; onClose: () => void; opener: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  return <Dialog.Root open={!!task} onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Overlay className="ui-dialog-overlay" />
    <Dialog.Content className="ui-task-drawer" onCloseAutoFocus={event => {
      event.preventDefault(); opener.current?.focus();
    }}>
      <header className="ui-panel-heading">
        <div><Dialog.Title><TextPreview text={task ? taskName(task, t) : t("tasks.detail")} /></Dialog.Title>
          <Dialog.Description>{task ? t(TASK_STAGE_LABELS[task.stage]) : t("value.unavailable")}</Dialog.Description></div>
        <Dialog.Close className="ui-icon-button" aria-label={t("web.close")}><X aria-hidden="true" /></Dialog.Close>
      </header>
      {task && <TaskDetails read={read} task={task} />}
    </Dialog.Content>
  </Dialog.Root>;
}
