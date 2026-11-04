import { useState } from "react";
import type { TeamOwnerRead, TeamReviewView } from "@openrig/daemon/team-control";
import { useTranslation } from "react-i18next";
import { LayoutGrid, List as ListIcon, Plus } from "lucide-react";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { RunGrowthForm } from "./run-growth.js";
import { NewTaskForm } from "./new-task.js";
import { ResultPanel } from "./result-panel.js";
import { TaskEditControls } from "./task-edit/task-edit-dialog.js";

/**
 * Slice A — the Tasks screen.
 *
 * The board groups the run's published tasks into the four working columns. A card shows the
 * task id, its title, its owner, its dependencies and its verified criteria. A field the read
 * model does not publish reads as an em dash rather than as an empty or invented value.
 */

export const BOARD_COLUMNS = ["pending", "in-progress", "review", "blocked"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** A task's column: review work is in progress by role, everything else follows its queue state. */
export function boardColumn(task: TeamReviewView): BoardColumn {
  if (task.queueState === "blocked" || task.queueState === "failed" || task.queueState === "denied") return "blocked";
  if (task.queueState === "done" || task.queueState === "handed-off") return "review";
  if (task.queueState === "in-progress") return "in-progress";
  if (task.role === "reviewer") return "review";
  return "pending";
}

export function groupTasks(tasks: readonly TeamReviewView[] | undefined): Record<BoardColumn, TeamReviewView[]> {
  const groups: Record<BoardColumn, TeamReviewView[]> = { pending: [], "in-progress": [], review: [], blocked: [] };
  for (const task of [...(tasks ?? [])].sort((a, b) => a.taskId.localeCompare(b.taskId))) groups[boardColumn(task)].push(task);
  return groups;
}

const DASH = "—";

function verified(task: TeamReviewView): string {
  return task.criteria.verified === null || task.criteria.total === null ? DASH : `${task.criteria.verified}/${task.criteria.total}`;
}

/** A dependency list: `—` when the assignment could not be read, and "None" when it recorded none. */
function dependencies(task: TeamReviewView, none: string): string {
  return task.dependencies === null ? DASH : task.dependencies.length === 0 ? none : task.dependencies.join(", ");
}

function TaskCard({ task, selected, onSelect }: { task: TeamReviewView; selected: boolean; onSelect: () => void }) {
  const { t } = useTranslation();
  return <li>
    <button type="button" className="ui-task-card" aria-pressed={selected} onClick={onSelect} data-task-id={task.taskId}>
      <span className="ui-task-card-head"><code>{task.taskId}</code><span className="ui-state" data-state={task.queueState}>{t(`status.queue.${task.queueState}`)}</span></span>
      <span className="ui-task-card-title">{task.title ?? DASH}</span>
      <span className="ui-task-card-meta">
        <span>{t("overview.colOwner")}: {t(`role.${task.role}`)}</span>
        <span>{t("tasks.dependencies")}: {dependencies(task, t("tasks.noDependencies"))}</span>
        <span>{t("overview.colVerified")}: {verified(task)}</span>
      </span>
    </button>
  </li>;
}

function Board({ groups, selected, onSelect }: { groups: Record<BoardColumn, TeamReviewView[]>; selected?: string; onSelect: (qitemId: string) => void }) {
  const { t } = useTranslation();
  return <div className="ui-board">
    {BOARD_COLUMNS.map(column => <section key={column} className="ui-column" aria-label={t(`tasks.column.${column}`)} data-column={column}>
      <h2>{t(`tasks.column.${column}`)}<span className="ui-count">{groups[column].length}</span></h2>
      {groups[column].length === 0 ? <p className="team-muted ui-column-empty">{t("tasks.empty")}</p>
        : <ul>{groups[column].map(task => <TaskCard key={task.qitemId} task={task} selected={selected === task.qitemId} onSelect={() => onSelect(task.qitemId)} />)}</ul>}
    </section>)}
  </div>;
}

function TaskList({ tasks, selected, onSelect }: { tasks: TeamReviewView[]; selected?: string; onSelect: (qitemId: string) => void }) {
  const { t } = useTranslation();
  return <Card className="ui-panel" role="region" aria-label={t("tasks.list")}>
    {tasks.length === 0 ? <p className="team-muted">{t("web.noTasks")}</p>
      : <table className="ui-table">
        <thead><tr>{(["overview.colId", "overview.colTask", "overview.colOwner", "overview.colState", "overview.colVerified", "tasks.dependencies"] as const)
          .map(key => <th key={key} scope="col">{t(key)}</th>)}</tr></thead>
        <tbody>{tasks.map(task => <tr key={task.qitemId} data-task-id={task.taskId} aria-selected={selected === task.qitemId}>
          <td><button type="button" className="ui-row-button" aria-pressed={selected === task.qitemId} onClick={() => onSelect(task.qitemId)}><code>{task.taskId}</code></button></td>
          <td className="team-muted">{task.title ?? DASH}</td>
          <td>{t(`role.${task.role}`)}</td>
          <td><span className="ui-state" data-state={task.queueState}>{t(`status.queue.${task.queueState}`)}</span></td>
          <td>{verified(task)}</td>
          <td>{dependencies(task, t("tasks.noDependencies"))}</td>
        </tr>)}</tbody>
      </table>}
  </Card>;
}

function Detail({ read, runId, task, onClose }: { read?: TeamOwnerRead; runId: string; task?: TeamReviewView; onClose: () => void }) {
  const { t } = useTranslation();
  const attempts = read?.attempts?.filter(attempt => task && (attempt.qitemId === task.qitemId || attempt.taskId === task.taskId)) ?? [];
  return <Card className="ui-panel ui-detail" role="region" aria-label={t("tasks.detail")}>
    {!task ? <p className="team-muted">{t("tasks.selectTask")}</p> : <>
      <div className="ui-detail-head">
        <h2><code>{task.taskId}</code></h2>
        <button type="button" className="ui-close" aria-label={t("web.close")} onClick={onClose}>×</button>
      </div>
      <p className="team-muted">{t(`role.${task.role}`)} · {t(`status.queue.${task.queueState}`)}</p>
      {task.title && <p>{task.title}</p>}
      <h3>{t("web.criteria")}</h3>
      <p>{task.criteria.verified === null || task.criteria.total === null ? DASH : t("tasks.criteriaOf", { verified: task.criteria.verified, total: task.criteria.total })}</p>
      {task.criteria.verified !== null && task.criteria.total !== null && task.criteria.total > 0 &&
        <span className="ui-meter"><span style={{ width: `${Math.round((task.criteria.verified / task.criteria.total) * 100)}%` }} /></span>}
      {/* The source is a durable column name. The owner reads what recorded the evidence, not the
          schema: a source this slice does not know is shown as its own name rather than guessed at. */}
      <p className="team-muted">{t("web.criteriaSource")}: {task.criteria.source === "team_queue_authority.evidence_json"
        ? t("tasks.criteriaSourceQueue") : <code>{task.criteria.source ?? DASH}</code>}</p>
      <h3>{t("tasks.dependencies")}</h3>
      <p className="team-muted">{dependencies(task, t("tasks.noDependencies"))}</p>
      <h3>{t("tasks.recentAttempts")}</h3>
      {attempts.length === 0 ? <p className="team-muted">{t("web.noAttempts")}</p>
        : <ul className="ui-attempts">{attempts.map(attempt => <li key={attempt.attemptId}>
          <code>{attempt.attemptId}</code>
          <span>{attempt.provider}</span>
          <span className="ui-state" data-state={attempt.state}>{t(`status.attempt.${attempt.state}`)}</span>
        </li>)}</ul>}
      {runId && <div className="ui-detail-actions"><TaskEditControls key={`${runId}:${task.taskId}`} runId={runId} taskId={task.taskId} /></div>}
      {runId && <ResultPanel runId={runId} taskId={task.taskId} />}
    </>}
  </Card>;
}

export function TasksScreen({ read, runId, query }: { read?: TeamOwnerRead; runId: string; query?: string }) {
  const { t } = useTranslation();
  const [view, setView] = useState<"board" | "list">("board");
  const [selected, setSelected] = useState<string>();
  const [showNew, setShowNew] = useState(false);
  const [showGrowth, setShowGrowth] = useState(false);
  const needle = (query ?? "").toLowerCase();
  const tasks = (read?.tasks ?? []).filter(task => !needle || task.taskId.toLowerCase().includes(needle));
  const task = tasks.find(item => item.qitemId === selected);
  const detail = task && <Detail read={read} runId={runId} task={task} onClose={() => setSelected(undefined)} />;
  return <div className="ui-tasks">
    <header className="ui-page-head">
      <div><h1>{t("nav.tasks")}</h1>
        <p className="ui-subtitle">{runId ? <><code>{runId}</code> · {t("tasks.count", { count: tasks.length })}</> : DASH}</p></div>
      <div className="ui-page-actions">
        <div className="ui-viewswitch" role="group" aria-label={t("tasks.view")}>
          <button type="button" aria-pressed={view === "board"} onClick={() => setView("board")}><LayoutGrid aria-hidden="true" />{t("tasks.board")}</button>
          <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}><ListIcon aria-hidden="true" />{t("tasks.list")}</button>
        </div>
        <Button variant="outline" onClick={() => setShowGrowth(value => !value)} disabled={!runId || !read?.tasks.length}>{t("edit.addTask")}</Button>
        <Button className="ui-primary" onClick={() => setShowNew(value => !value)} disabled={!runId}><Plus aria-hidden="true" />{t("web.newTask")}</Button>
      </div>
    </header>
    {showNew && <NewTaskForm />}
    {showGrowth && read?.tasks[0] && <RunGrowthForm key={runId} runId={runId} anchorTaskId={read.tasks[0].taskId} />}
    <div className={"ui-tasks-body" + (task ? "" : " ui-tasks-body-solo")}>
      <div className="ui-tasks-main">
        {view === "board" ? <Board groups={groupTasks(tasks)} selected={selected} onSelect={setSelected} />
          : <TaskList tasks={tasks} selected={selected} onSelect={setSelected} />}
      </div>
      {detail}
    </div>
  </div>;
}
