import type { TeamApproval, TeamQueueState, TeamRun, TeamSystemHealth } from "@openrig/daemon/team-control";
import { useTranslation } from "react-i18next";
import { Card } from "../components/ui/card.js";
import { Button } from "../components/ui/button.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.js";
import { TaskList } from "./task-list.js";
import { AgentStatus } from "./agent-status.js";
import { SystemStatus } from "./system-status.js";
import { Activity } from "./activity.js";

function TaskDetail({ tab, onTab }: { tab: string; onTab: (value: string) => void }) {
  const { t } = useTranslation();
  return <Card className="team-card team-task-detail" data-scroll-pane="task-detail" role="region" aria-label={t("web.taskDetail")}>
    <h2>{t("web.taskDetail")}</h2>
    <Tabs value={tab} onValueChange={onTab}><TabsList aria-label={t("web.taskDetail")}>
      {(["details", "discussion", "changes", "tests", "reviewRecord"] as const).map(tab =>
        <TabsTrigger key={tab} value={tab}>{t(`web.${tab}`)}</TabsTrigger>)}
    </TabsList>
    <TabsContent value="details"><p className="team-muted">{t("web.pending")}</p>
      <dl className="team-detail-facts">{(["criteria", "dependencies", "owners", "timestamps"] as const).map(field =>
        <div key={field}><dt>{t(`web.${field}`)}</dt><dd>{t("web.unknown")}</dd></div>)}</dl>
    </TabsContent>
    {(["discussion", "changes", "tests", "reviewRecord"] as const).map(tab => <TabsContent value={tab} key={tab}>
      <p>{t("web.readOnly")}</p><p className="team-muted">{t("web.pending")}</p>
    </TabsContent>)}
    </Tabs>
  </Card>;
}

function PendingDecisions({ approvals }: { approvals?: TeamApproval[] }) {
  const { t } = useTranslation();
  const pending = approvals?.filter(item => item.state === "pending");
  return <Card className="team-card team-decisions" role="region" aria-label={t("web.pendingDecisions")}>
    <h2>{t("web.pendingDecisions")} <span>{pending?.length ?? "?"}</span></h2>
    {pending === undefined ? <p>{t("web.unknown")}</p> : !pending.length ? <p>{t("web.noDecisions")}</p> :
      <ul>{pending.map(item => <li key={item.id}>
        <strong>{item.action}</strong><code>{item.id}</code>
        <dl className="team-facts"><div><dt>{t("web.target")}</dt><dd><code>{item.targetDigest}</code></dd></div>
          <div><dt>{t("web.binding")}</dt><dd><code>{item.bindingDigest}</code></dd></div>
          <div><dt>{t("web.version")}</dt><dd>{item.entityVersion}</dd></div></dl>
        {item.kind === "native" && <><Button disabled variant="outline">{t("web.openSession")}</Button><p>{t("web.nativeTarget")}</p></>}
      </li>)}</ul>}
    <p className="team-muted">{t("web.decisionControls")}</p>
  </Card>;
}

export function EvidencePanel({ tab, onTab }: { tab: string; onTab: (value: string) => void }) {
  const { t } = useTranslation();
  return <Card className="team-card team-evidence" data-scroll-pane="evidence" role="region" aria-label={t("web.evidence")}>
    <h2 className="sr-only">{t("web.evidence")}</h2>
    <Tabs value={tab} onValueChange={onTab}><TabsList aria-label={t("web.evidence")}>
      <TabsTrigger value="terminal" disabled className="team-owner-terminal">{t("web.terminal")}</TabsTrigger>
      <TabsTrigger value="logs">{t("web.logs")}</TabsTrigger>
      <TabsTrigger value="review">{t("web.reviewConversation")}</TabsTrigger>
    </TabsList>
    <TabsContent value="logs"><p>{t("web.logPending")}</p><p className="team-muted team-owner-terminal">{t("web.terminalPending")}</p></TabsContent>
    <TabsContent value="review"><p>{t("web.readOnly")}</p><p>{t("web.pending")}</p></TabsContent>
    </Tabs>
  </Card>;
}

function Usage({ run }: { run?: TeamRun }) {
  const { t } = useTranslation();
  const metrics = { costUsd: "web.cost", inputTokens: "web.inputTokens", outputTokens: "web.outputTokens" } as const;
  return <Card className="team-card" role="region" aria-label={t("web.usage")}><h2>{t("web.usage")}</h2>
    <dl className="team-facts">{(Object.keys(metrics) as Array<keyof typeof metrics>).map(name => <div key={name}>
      <dt>{t(metrics[name])}</dt><dd>{run?.usage[name].value ?? t("web.unknown")}<small>{run?.usage[name].reason}</small></dd>
    </div>)}</dl>
  </Card>;
}

export function Overview({ section, run, runId, approvals, health, healthAvailable, now, filter, search, sort, onFilter, onSearch, onSort, detailTab, evidenceTab, onDetailTab, onEvidenceTab }: {
  section: string; run?: TeamRun; runId: string; approvals?: TeamApproval[]; health?: TeamSystemHealth;
  detailTab: string; evidenceTab: string; onDetailTab: (value: string) => void; onEvidenceTab: (value: string) => void;
  healthAvailable: boolean; now: number; filter: TeamQueueState | "all"; search: string; sort: string;
  onFilter: (value: TeamQueueState | "all") => void; onSearch: (value: string) => void; onSort: (value: string) => void;
}) {
  const { t } = useTranslation();
  if (section === "agents") return <AgentStatus health={health} runId={runId} />;
  if (section === "decisions") return <PendingDecisions approvals={approvals} />;
  if (section === "logs") return <EvidencePanel tab={evidenceTab} onTab={onEvidenceTab} />;
  if (!["overview", "tasks"].includes(section)) return <Card className="team-card"><p>{t("web.laterPage")}</p></Card>;
  return <>
    <div className="team-work-grid">
      <div className="team-task-columns"><TaskList {...{ filter, search, sort, onFilter, onSearch, onSort }} /><TaskDetail tab={detailTab} onTab={onDetailTab} /></div>
      <aside className="team-monitoring" data-scroll-pane="monitoring" tabIndex={0} aria-label={t("web.system")}>
        <PendingDecisions approvals={approvals} />
        <AgentStatus health={health} runId={runId} />
        <SystemStatus run={run} health={health} available={healthAvailable} now={now} />
        <Usage run={run} /><Activity />
      </aside>
    </div>
    <EvidencePanel tab={evidenceTab} onTab={onEvidenceTab} />
  </>;
}
