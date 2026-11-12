import { useTranslation } from "react-i18next";
import { Circle, CircleCheck, CircleX, MinusCircle } from "lucide-react";
import type { AttemptActivity, TeamAttemptView, TeamOwnerRead, TeamReviewView, TeamSeatView, ToolActivityRecord } from "@multi-agent/daemon/team-control";
import { useAttemptActivity } from "../../hooks/useAttemptActivity.js";
import { useAttemptStatus } from "../../hooks/useAttemptStatus.js";
import { clockTime, namedSeat, TASK_STAGE_LABELS, taskName } from "../display.js";
import { observedTokens } from "../hooks.js";

export function attemptForSeat(read: TeamOwnerRead | undefined, seat: TeamSeatView): TeamAttemptView | undefined {
  return read?.attempts.filter(attempt => attempt.session === seat.seat).at(-1);
}

export function taskForSeat(read: TeamOwnerRead | undefined, seat: TeamSeatView): TeamReviewView | undefined {
  const tasks = read?.tasks.filter(task => task.seat === seat.seat) ?? [];
  const attempt = attemptForSeat(read, seat);
  return tasks.find(task => task.taskId === attempt?.taskId) ?? tasks.find(task => task.stage !== "done") ?? tasks.at(-1);
}

export function ActivityFacts({ activity }: { activity?: AttemptActivity }) {
  const { t, i18n } = useTranslation();
  const tokens = observedTokens(activity ? [activity.usage] : []);
  return <dl className="ui-agent-facts">
    <div><dt>{t("workspace.model")}</dt><dd>{activity?.usage.model ?? "—"}</dd></div>
    <div><dt>{t("workspace.tokens")}</dt><dd>{tokens.tokens === null ? "—" : new Intl.NumberFormat(i18n.resolvedLanguage).format(tokens.tokens)}
      {tokens.partial && tokens.tokens !== null && <small>{t("workspace.partial")}</small>}</dd></div>
  </dl>;
}

export function ToolCallRow({ record }: { record: ToolActivityRecord }) {
  const { t } = useTranslation();
  const status = record.status === "completed" ? "succeeded" : record.status;
  const Glyph = { running: Circle, succeeded: CircleCheck, failed: CircleX, aborted: MinusCircle }[status];
  return <li className="ui-tool-call" data-call={record.id} data-status={status}>
    <Glyph role="img" aria-label={t(("workspace.call." + status) as "workspace.call.running")} />
    <div><strong>{record.tool}</strong><p>{record.summary}</p></div><time dateTime={record.at}>{clockTime(record.at)}</time>
  </li>;
}

export function ToolCalls({ activity, error, recent = false }: { activity?: AttemptActivity; error?: boolean; recent?: boolean }) {
  const { t } = useTranslation();
  if (error || !activity || activity.activityStatus === "unavailable") return <p className="ui-muted">{t("workspace.activityUnavailable")}</p>;
  const calls = recent ? activity.records.slice(-3) : activity.records;
  return <>
    {calls.length === 0 ? <p className="ui-muted">{t("workspace.noCalls")}</p>
      : <ol className="ui-tool-calls" aria-label={t("workspace.tools")}>{calls.map(record => <ToolCallRow key={record.id} record={record} />)}</ol>}
    {activity.activityStatus === "partial" && <p className="ui-muted">{t("workspace.partialActivity")}</p>}
  </>;
}

export function SeatHeading({ seat, task }: { seat: TeamSeatView; task?: TeamReviewView }) {
  const { t } = useTranslation();
  return <><strong>{namedSeat(seat, t)}</strong>
    <span className="ui-stage" data-stage={task?.stage}>{seat.retired ? t("workspace.retired")
      : task ? t(TASK_STAGE_LABELS[task.stage]) : t("shell.idle")}</span>
    <p className="ui-agent-task">{task ? taskName(task, t) : t("workspace.noTask")}</p></>;
}

function AgentCard({ read, seat, selected, onSelect }: {
  read: TeamOwnerRead; seat: TeamSeatView; selected: boolean; onSelect: (seat: string) => void;
}) {
  const { t } = useTranslation();
  const attempt = attemptForSeat(read, seat);
  const activity = useAttemptActivity(read.runId, attempt);
  const status = useAttemptStatus(read.runId, attempt, !!activity.data?.records.length || activity.data?.usage.status === "available");
  return <article ref={activity.ref} className="ui-card ui-agent-card" aria-label={namedSeat(seat, t)} data-retired={seat.retired}>
    <button className="ui-agent-select" aria-pressed={selected} onClick={() => onSelect(seat.seat)}>
      <SeatHeading seat={seat} task={taskForSeat(read, seat)} />
    </button>
    {attempt?.state === "running" && status && <span role="status">{t(`status.attempt.${status}`)}</span>}
    <ActivityFacts activity={activity.data} /><ToolCalls activity={activity.data} error={activity.isError} recent />
  </article>;
}

export function WorkspaceView({ read, selected, onSelect }: {
  read?: TeamOwnerRead; selected: string; onSelect: (seat: string) => void;
}) {
  const { t } = useTranslation();
  if (!read) return <p className="ui-muted">{t("value.unavailable")}</p>;
  return <div className="ui-agent-grid">{read.seats.map(seat =>
    <AgentCard key={seat.seat} read={read} seat={seat} selected={selected === seat.seat} onSelect={onSelect} />)}</div>;
}
