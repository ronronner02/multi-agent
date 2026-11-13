import { TextPreview } from "./text-preview.js";
import { useRef, useState } from "react";
import type { TeamOwnerRead, TeamReviewView } from "@multi-agent/daemon/team-control";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { assignedSeat, TASK_STAGE_LABELS, taskName } from "./display.js";
import { TaskProgress } from "./task-progress.js";
import { TaskDrawer } from "./task-drawer.js";
import { TaskWorkbench } from "./task-workbench.js";

export const BOARD_COLUMNS = ["queued", "running", "review", "lead/report", "owner/decision", "done"] as const;
type BoardColumn = typeof BOARD_COLUMNS[number];

export function groupTasks(tasks: readonly TeamReviewView[]): Record<BoardColumn, TeamReviewView[]> {
  const groups: Record<BoardColumn, TeamReviewView[]> = { queued: [], running: [], review: [],
    "lead/report": [], "owner/decision": [], done: [] };
  for (const task of tasks) groups[task.stage === "owner/blocked" || task.stage === "owner/question" ? "owner/decision" : task.stage].push(task);
  return groups;
}

export function TasksScreen({ read, selectedTaskId, onSelect, onNewTask, onOpenWorkspace, onOpenReviews }: {
  onOpenWorkspace?: (taskId: string) => void; onOpenReviews?: (taskId: string) => void;
  read?: TeamOwnerRead; selectedTaskId: string; onSelect: (taskId: string) => void; onNewTask: () => void;
}) {
  const { t } = useTranslation();
  const opener = useRef<HTMLElement | null>(null);
  const [view, setView] = useState<"list" | "board">("list");
  const heading = useRef<HTMLHeadingElement>(null);
  const tasks = read?.tasks ?? [];
  const groups = groupTasks(tasks);
  return <main className="ui-screen ui-tasks">
    <header className="ui-page-head">
      <div><h1 ref={heading} tabIndex={-1}>{t("nav.tasks")}</h1>
        <div className="ui-subtitle"><TextPreview text={read ? read.run.displayName + " · " + t("tasks.count", { count: tasks.length }) : t("value.unavailable")} /></div></div>
      <button className="btn btn-primary" disabled={!read} onClick={onNewTask}><Plus aria-hidden="true" />{t("web.newTask")}</button>
    </header>
    <div className="ui-layout-switch ui-task-view-switch" role="group" aria-label={t("tasks.view")}>
      {(["list", "board"] as const).map(layout => <button key={layout} aria-pressed={view === layout}
        onClick={() => { setView(layout); onSelect(""); }}>{t(layout === "list" ? "tasks.list" : "tasks.board")}</button>)}
    </div>
    {!read ? <p className="ui-muted">{t("value.unavailable")}</p> : view === "list"
      ? <TaskWorkbench key={read.runId} read={read} selectedTaskId={selectedTaskId} onSelect={onSelect} onOpenWorkspace={onOpenWorkspace} onOpenReviews={onOpenReviews} /> : <div className="ui-board">
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
    <TaskDrawer read={read} task={view === "board" ? tasks.find(task => task.taskId === selectedTaskId) : undefined}
      onClose={() => { if (!opener.current?.isConnected) opener.current = heading.current; onSelect(""); }} opener={opener} />
  </main>;
}
