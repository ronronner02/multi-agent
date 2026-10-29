import type { TeamOwnerRead, TeamQueueState, TeamReadModel, TeamRun, TeamSystemHealth } from "@openrig/daemon/team-control";
import { useTranslation } from "react-i18next";
import { Card } from "../components/ui/card.js";
import { useState } from "react";
import { TaskDetail } from "./task-detail.js";
import { BottomPanel, type TerminalTarget } from "./bottom-panel.js";
import { ReviewDecisions } from "./review-decisions.js";
import { TaskList } from "./task-list.js";
import { AgentStatus } from "./agent-status.js";
import { SystemStatus } from "./system-status.js";
import { Activity } from "./activity.js";
import { DecisionCard } from "./decision-card.js";

function Usage({ run }: { run?: TeamRun }) {
  const { t } = useTranslation();
  const metrics = { costUsd: "web.cost", inputTokens: "web.inputTokens", outputTokens: "web.outputTokens" } as const;
  return <Card className="team-card" role="region" aria-label={t("web.usage")}><h2>{t("web.usage")}</h2>
    <dl className="team-facts">{(Object.keys(metrics) as Array<keyof typeof metrics>).map(name => <div key={name}>
      <dt>{t(metrics[name])}</dt><dd>{run?.usage[name].value ?? t("web.unknown")}<small>{run?.usage[name].reason}</small></dd>
    </div>)}</dl>
  </Card>;
}

export function Overview({ controlsAvailable, refresh, section, run, runId, health, healthAvailable, now, filter, search, sort, onFilter, onSearch, onSort, detailTab, evidenceTab, onDetailTab, onEvidenceTab, read, replay, selectedTask, onSelectTask }: {
  controlsAvailable: boolean; refresh: () => Promise<unknown>;
  read?: TeamOwnerRead; replay?: ReturnType<TeamReadModel["replay"]>; selectedTask?: string; onSelectTask: (qitemId: string) => void;
  section: string; run?: TeamRun; runId: string; health?: TeamSystemHealth;
  detailTab: string; evidenceTab: string; onDetailTab: (value: string) => void; onEvidenceTab: (value: string) => void;
  healthAvailable: boolean; now: number; filter: TeamQueueState | "all"; search: string; sort: string;
  onFilter: (value: TeamQueueState | "all") => void; onSearch: (value: string) => void; onSort: (value: string) => void;
}) {
  const { t } = useTranslation();
  const task = read?.tasks.find(item => item.qitemId === selectedTask) ?? read?.tasks[0];
  const [target, setTarget] = useState<TerminalTarget>(null);
  const openSession = (attempt: Exclude<TerminalTarget, "owner" | null>) => { setTarget(attempt); onEvidenceTab("terminal"); };
  const decisions = <DecisionCard read={controlsAvailable ? read : undefined} available={controlsAvailable} now={now} refresh={refresh} onOpenSession={openSession} />;
  const agents = <AgentStatus health={health} runId={runId} attempts={read?.attempts} onOpenSession={controlsAvailable ? openSession : undefined} />;
  const bottom = <BottomPanel tab={evidenceTab} onTab={onEvidenceTab} read={read} available={controlsAvailable} target={target} onTarget={setTarget} />;
  if (section === "agents") return <>{agents}{bottom}</>;
  if (section === "decisions") return <>{decisions}<ReviewDecisions tasks={read?.tasks} />{bottom}</>;
  if (section === "logs") return bottom;
  if (!["overview", "tasks"].includes(section)) return <Card className="team-card"><p>{t("web.laterPage")}</p></Card>;
  return <>
    <div className="team-work-grid">
      <div className="team-task-columns"><TaskList {...{ filter, search, sort, onFilter, onSearch, onSort }} tasks={read?.tasks} selected={task?.qitemId} onSelect={onSelectTask} /><TaskDetail tab={detailTab} onTab={onDetailTab} task={task} /></div>
      <aside className="team-monitoring" data-scroll-pane="monitoring" tabIndex={0} aria-label={t("web.system")}>
        {decisions}
        {agents}
        <SystemStatus run={run} health={health} available={healthAvailable} now={now} />
        <Usage run={run} /><Activity read={read} replay={replay} />
      </aside>
    </div>
    {bottom}
  </>;
}
