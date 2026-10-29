import { useState } from "react";
import type { TeamOwnerRead } from "@openrig/daemon/team-control";
import { useTranslation } from "react-i18next";

export function Logs({ read }: { read?: Pick<TeamOwnerRead, "tasks" | "logs"> }) {
  const { t } = useTranslation();
  const [task, setTask] = useState(""), [attempt, setAttempt] = useState("");
  const tasks = [...new Set([...(read?.tasks.map(item => item.taskId) ?? []), ...(read?.logs.flatMap(item => item.taskId ? [item.taskId] : []) ?? [])])];
  const attempts = [...new Set(read?.logs.filter(item => !task || item.taskId === task).flatMap(item => item.attemptId ? [item.attemptId] : []) ?? [])];
  const logs = read?.logs.filter(item => (!task || item.taskId === task) && (!attempt || item.attemptId === attempt));
  return <>
    <div className="team-log-filters">
      <label>{t("web.taskId")}<select value={task} onChange={event => { setTask(event.target.value); setAttempt(""); }}>
        <option value="">{t("web.allTasks")}</option>{tasks.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
      <label>{t("web.attempt")}<select value={attempt} onChange={event => setAttempt(event.target.value)}>
        <option value="">{t("web.allAttempts")}</option>{attempts.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
    </div>
    {!logs ? <p>{t("web.logPending")}</p> : !logs.length ? <p>{t("web.noLogs")}</p> : logs.map((log, index) =>
      <div key={(log.streamItemId ?? log.source) + "-" + index} className="team-log"><time>{log.ts}</time> <code>{log.taskId} {log.attemptId} {log.session}</code>
        {log.exitOutcome && <span>{t(`status.queue.${log.exitOutcome}`)}</span>}<pre>{log.body}</pre>{log.truncated && <small>{t("web.truncated")}</small>}
      </div>)}
  </>;
}
