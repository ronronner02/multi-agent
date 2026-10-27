import { TEAM_QUEUE_STATES, type TeamQueueState, type TeamReviewView } from "../../../daemon/dist/contracts/team-control.js";
import { useTranslation } from "react-i18next";
import { Card } from "../components/ui/card.js";
import { Button } from "../components/ui/button.js";

export function TaskList({ filter, search, sort, onFilter, onSearch, onSort, tasks, selected, onSelect }: {
  tasks?: TeamReviewView[]; selected?: string; onSelect: (qitemId: string) => void;
  filter: TeamQueueState | "all"; search: string; sort: string;
  onFilter: (value: TeamQueueState | "all") => void; onSearch: (value: string) => void; onSort: (value: string) => void;
}) {
  const { t } = useTranslation();
  const rows = tasks?.filter(task => (filter === "all" || task.queueState === filter)
    && `${task.taskId} ${task.qitemId}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => a.taskId.localeCompare(b.taskId));
  return <Card className="team-card" data-scroll-pane="task-list" role="region" aria-label={t("web.taskList")}>
    <h2>{t("web.taskList")}</h2>
    <div className="team-filters" role="group" aria-label={t("web.tasks")}>
      {(["all", ...TEAM_QUEUE_STATES] as const).map(state => <Button key={state} variant="ghost"
        aria-pressed={state === filter} onClick={() => onFilter(state)}>
        {state === "all" ? t("web.all") : t(`status.queue.${state}`)}
      </Button>)}
    </div>
    <div className="team-search"><input aria-label={t("web.search")} placeholder={t("web.search")} value={search} onChange={e => onSearch(e.target.value)} />
      <select aria-label={t("web.sort")} value={sort} onChange={e => onSort(e.target.value)}>
        <option value="priority" disabled>{t("web.priority")}</option><option value="id">{t("web.taskId")}</option>
      </select></div>
    <div className="team-list-head"><span>{t("web.taskId")}</span><span>{t("web.progress")}</span></div>
    {rows === undefined ? <p>{t("value.unavailable")}</p> : rows.length === 0 ? <p>{t("web.noTasks")}</p> :
      <ul className="team-task-rows">{rows.map(task => <li key={task.qitemId} data-task-id={task.taskId}>
        <Button variant="ghost" aria-pressed={selected === task.qitemId} onClick={() => onSelect(task.qitemId)}><code>{task.taskId}</code></Button>
        <span>{t(`status.queue.${task.queueState}`)}</span><span>{t(`role.${task.role}`)}</span>
        <span>{task.criteria.verified === null || task.criteria.total === null ? t("value.unavailable") : `${task.criteria.verified}/${task.criteria.total}`}</span>
      </li>)}</ul>}
  </Card>;
}
