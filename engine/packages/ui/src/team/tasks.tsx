import { useRef } from "react";
import type { TeamOwnerRead, TeamReviewView } from "@openrig/daemon/team-control";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { assignedSeat, TASK_STAGE_LABELS, taskName } from "./display.js";
import { TaskProgress } from "./task-progress.js";
import { TaskDrawer } from "./task-drawer.js";

export const BOARD_COLUMNS = ["queued", "running", "review", "lead/report", "owner/decision", "done"] as const;
type BoardColumn = typeof BOARD_COLUMNS[number];

export function groupTasks(tasks: readonly TeamReviewView[]): Record<BoardColumn, TeamReviewView[]> {
  const groups: Record<BoardColumn, TeamReviewView[]> = { queued: [], running: [], review: [],
    "lead/report": [], "owner/decision": [], done: [] };
  for (const task of tasks) groups[task.stage === "owner/blocked" ? "owner/decision" : task.stage].push(task);
  return groups;
}

export function TasksScreen({ read, selectedTaskId, onSelect, onNewTask }: {
  read?: TeamOwnerRead; selectedTaskId: string; onSelect: (taskId: string) => void; onNewTask: () => void;
}) {
  const { t } = useTranslation();
  const opener = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const tasks = read?.tasks ?? [];
  const groups = groupTasks(tasks);
  return <main className="ui-screen ui-tasks">
    <header className="ui-page-head">
      <div><h1 ref={heading} tabIndex={-1}>{t("nav.tasks")}</h1>
        <p className="ui-subtitle">{read ? read.run.displayName + " · " + t("tasks.count", { count: tasks.length }) : t("value.unavailable")}</p></div>
      <button className="btn btn-primary" disabled={!read} onClick={onNewTask}><Plus aria-hidden="true" />{t("web.newTask")}</button>
    </header>
    {!read ? <p className="ui-muted">{t("value.unavailable")}</p> : <div className="ui-board">
      {BOARD_COLUMNS.map(column => <section key={column} className="ui-column" aria-label={t(TASK_STAGE_LABELS[column])}>
        <h2>{t(TASK_STAGE_LABELS[column])}<span className="ui-count">{groups[column].length}</span></h2>
        {groups[column].length === 0 ? <p className="ui-muted ui-column-empty">{t("tasks.empty")}</p>
          : <ul>{groups[column].map(task => <li key={task.taskId}>
            <button className="ui-task-card" aria-haspopup="dialog" aria-pressed={selectedTaskId === task.taskId}
              onClick={event => { opener.current = event.currentTarget; onSelect(task.taskId); }}>
              <strong>{taskName(task, t)}</strong>
              <span className="ui-muted">{assignedSeat(task, read.seats, t)}</span>
              <TaskProgress task={task} />
            </button>
          </li>)}</ul>}
      </section>)}
    </div>}
    <TaskDrawer read={read} task={tasks.find(task => task.taskId === selectedTaskId)}
      onClose={() => { if (!opener.current?.isConnected) opener.current = heading.current; onSelect(""); }} opener={opener} />
  </main>;
}
