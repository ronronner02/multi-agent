import { TextPreview } from "./text-preview.js";
import { useId, useState } from "react";
import type { TeamOwnerRead, TeamTaskStage } from "@openrig/daemon/team-control";
import { useTranslation } from "react-i18next";
import { ArrowRight, Search } from "lucide-react";
import { assignedSeat, TASK_STAGE_LABELS, taskName } from "./display.js";
import { TaskProgress } from "./task-progress.js";
import { TaskDetails } from "./task-drawer.js";

type Filter = "all" | "active" | TeamTaskStage;

export function TaskWorkbench({ read, selectedTaskId, onSelect, onOpenAll, onOpenTask, onOpenWorkspace, onOpenReviews, initialFilter = "all" }: {
  read: TeamOwnerRead; selectedTaskId: string; onSelect: (taskId: string) => void;
  onOpenWorkspace?: (taskId: string) => void; onOpenReviews?: (taskId: string) => void;
  onOpenAll?: () => void; onOpenTask?: (taskId: string) => void; initialFilter?: Filter;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [chosenFilter, setFilter] = useState<Filter>();
  const filter = chosenFilter ?? initialFilter;
  const inspectorId = useId();
  const needle = query.trim().toLocaleLowerCase();
  const tasks = read.tasks.filter(task => (filter === "all" || (filter === "active" ? task.stage !== "done" : task.stage === filter))
    && (taskName(task, t) + " " + assignedSeat(task, read.seats, t)).toLocaleLowerCase().includes(needle));
  const selected = tasks.find(task => task.taskId === selectedTaskId) ?? tasks[0];
  return <div className="ui-task-workbench" data-empty={tasks.length === 0}>
    <section className="ui-card ui-workbench-list" aria-label={t("tasks.listHeading")}>
      <div className="ui-section-head"><h2>{t("tasks.listHeading")}<span className="ui-count">{tasks.length}</span></h2>
        {onOpenAll && <button className="btn btn-quiet" onClick={onOpenAll}>{t("overview.viewAllTasks")}<ArrowRight aria-hidden="true" /></button>}
      </div>
      <div className="ui-task-filters">
        <label className="ui-task-search"><Search aria-hidden="true" />
          <input type="search" aria-label={t("tasks.search")} placeholder={t("tasks.search")} value={query}
            onChange={event => { setQuery(event.target.value); onSelect(""); }} />
        </label>
        <select aria-label={t("tasks.status")} value={filter} onChange={event => { setFilter(event.target.value as Filter); onSelect(""); }}>
          <option value="all">{t("tasks.all")}</option><option value="active">{t("tasks.active")}</option>
          {Object.entries(TASK_STAGE_LABELS).map(([stage, label]) => <option key={stage} value={stage}>{t(stage === "owner/blocked" ? "tasks.column.blocked" : label)}</option>)}
        </select>
      </div>
      {tasks.length === 0 ? <p className="ui-muted ui-workbench-empty">{t("tasks.empty")}</p>
        : <ul className="ui-active-list">{tasks.map(task => <li key={task.taskId}>
          <button aria-pressed={selected?.taskId === task.taskId} aria-controls={inspectorId} onClick={() => onSelect(task.taskId)}>
            <span><strong>{taskName(task, t)}</strong><small>{assignedSeat(task, read.seats, t)}</small></span>
            <span className="ui-stage" data-stage={task.stage}>{t(TASK_STAGE_LABELS[task.stage])}</span>
            <TaskProgress task={task} />
          </button>
        </li>)}</ul>}
    </section>
    <section id={inspectorId} className="ui-card ui-task-inspector" hidden={!selected} aria-label={t("tasks.detail")}>
      {selected ? <>
        <header className="ui-panel-heading"><div><h2><TextPreview text={taskName(selected, t)} /></h2><p>{t(TASK_STAGE_LABELS[selected.stage])}</p></div>
          {onOpenTask && <button className="ui-icon-button" aria-label={t("tasks.openTask")} onClick={() => onOpenTask(selected.taskId)}><ArrowRight aria-hidden="true" /></button>}
        </header>
        {(onOpenWorkspace || onOpenReviews) && <div className="ui-inspector-links">
          {onOpenWorkspace && <button className="btn btn-quiet" onClick={() => onOpenWorkspace(selected.taskId)}>{t("nav.workspace")}</button>}
          {onOpenReviews && <button className="btn btn-quiet" onClick={() => onOpenReviews(selected.taskId)}>{t("nav.reviews")}</button>}
        </div>}
        <TaskDetails key={selected.taskId} read={read} task={selected} />
      </> : <p className="ui-muted ui-workbench-empty">{t("tasks.selectTask")}</p>}
    </section>
  </div>;
}
