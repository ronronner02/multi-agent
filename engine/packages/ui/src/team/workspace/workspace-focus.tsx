import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TeamOwnerRead, TeamReviewView, TeamSeatView } from "@multi-agent/daemon/team-control";
import { useAttemptActivity } from "../../hooks/useAttemptActivity.js";
import { useAttemptStatus } from "../../hooks/useAttemptStatus.js";
import { isFinished, useTeamResult } from "../../hooks/useTeamResult.js";
import { DiffView } from "../diff-view.js";
import { TaskProgress } from "../task-progress.js";
import { ActivityFacts, attemptForSeat, SeatHeading, taskForSeat, ToolCalls } from "./workspace-view.js";

export function TaskChanges({ runId, task }: { runId: string; task?: TeamReviewView }) {
  const { t } = useTranslation();
  const finished = !!task && isFinished(task.queueState);
  const result = useTeamResult(runId, task?.taskId ?? null, finished, task?.currentCandidateDigest ?? null);
  if (!task) return <p className="ui-muted">{t("workspace.noTask")}</p>;
  if (!finished) return <p className="ui-muted">{t("workspace.resultPending")}</p>;
  if (!task.currentCandidateDigest) return <p className="ui-muted">{t("reviews.noCandidate")}</p>;
  if (result.isPending) return <p className="ui-muted" role="status">{t("web.loading")}</p>;
  if (result.isError) return <p className="ui-muted" role="alert">{t("web.resultUnavailable")}</p>;
  return <DiffView patch={result.data.patch} />;
}

export function WorkspaceFocus({ read, seat }: { read: TeamOwnerRead; seat: TeamSeatView }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"execution" | "changes" | "output">("execution");
  const task = taskForSeat(read, seat);
  const attempt = attemptForSeat(read, seat);
  const activity = useAttemptActivity(read.runId, attempt);
  const status = useAttemptStatus(read.runId, attempt, !!activity.data?.records.length || activity.data?.usage.status === "available");
  const logs = read.logs.filter(log => log.taskId === task?.taskId);
  return <section ref={activity.ref} className="ui-card ui-agent-detail" aria-label={t("workspace.identity")}>
    <header className="ui-agent-detail-head"><SeatHeading seat={seat} task={task} /></header>
    {attempt?.state === "running" && status && <span role="status">{t(`status.attempt.${status}`)}</span>}
    <ActivityFacts activity={activity.data} />
    <div className="ui-detail-tabs" role="group" aria-label={t("workspace.tabs")}>
      {(["execution", "changes", "output"] as const).map(name => <button key={name} aria-pressed={tab === name} onClick={() => setTab(name)}>
        {t(("workspace." + name) as "workspace.execution")}</button>)}
    </div>
    <div className="ui-detail-content">
      {tab === "execution" && <ToolCalls activity={activity.data} error={activity.isError} />}
      {tab === "changes" && <TaskChanges runId={read.runId} task={task} />}
      {tab === "output" && (logs.length === 0 ? <p className="ui-muted">{t("workspace.noOutput")}</p>
        : <details><summary>{t("workspace.output")}</summary><pre className="ui-agent-output">{logs.map(log => log.body).join("\n")}</pre></details>)}
    </div>
    {task && <footer className="ui-agent-progress"><TaskProgress task={task} /></footer>}
  </section>;
}
