import { TEAM_QUEUE_STATES, type TeamQueueState } from "@openrig/daemon/team-control";
import { useTranslation } from "react-i18next";
import { Card } from "../components/ui/card.js";
import { Button } from "../components/ui/button.js";

export function TaskList({ filter, search, sort, onFilter, onSearch, onSort }: {
  filter: TeamQueueState | "all"; search: string; sort: string;
  onFilter: (value: TeamQueueState | "all") => void; onSearch: (value: string) => void; onSort: (value: string) => void;
}) {
  const { t } = useTranslation();
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
        <option value="priority">{t("web.priority")}</option><option value="id">{t("web.taskId")}</option>
      </select></div>
    <div className="team-list-head"><span>{t("web.taskId")}</span><span>{t("web.progress")}</span></div>
    <div className="team-unavailable"><strong>{t("web.pending")}</strong><p>{t("web.taskPending")}</p></div>
  </Card>;
}
