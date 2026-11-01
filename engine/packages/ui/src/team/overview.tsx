import type { TeamOwnerRead, TeamReviewView, TeamRun, TeamRunStageView } from "@openrig/daemon/team-control";
import { useTranslation } from "react-i18next";
import { ArrowRight, TriangleAlert } from "lucide-react";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";

/**
 * Slice A — the run Overview.
 *
 * Everything here comes from the owner read model. Where it publishes no value — a task title, a
 * token count, a cost — the screen shows an em dash instead of a zero, because zero is a measured
 * result and "not published" is not one.
 */

const DASH = "—";

/** The four stage groups the progress line shows, over the read model's seven stages. */
const STAGE_GROUPS = [
  { label: "progress.plan", stages: ["setup-checks", "plan-approved", "assignments-derived"] },
  { label: "progress.build", stages: ["execution"] },
  { label: "progress.review", stages: ["review"] },
  { label: "progress.verify", stages: ["integration-verification", "delivery-decision"] },
] as const;

const STAGE_LABELS = {
  "setup-checks": "web.stage.setup", "plan-approved": "web.stage.plan", "assignments-derived": "web.stage.assignments",
  execution: "web.stage.execution", review: "web.stage.review", "integration-verification": "web.stage.integration", "delivery-decision": "web.stage.delivery",
} as const;

/** Sum of verified criteria, or null when no task published a criteria record. */
export function verifiedChecks(tasks: readonly TeamReviewView[]): { verified: number; total: number } | null {
  let verified = 0, total = 0, known = false;
  for (const task of tasks) {
    if (task.criteria.verified === null || task.criteria.total === null) continue;
    verified += task.criteria.verified; total += task.criteria.total; known = true;
  }
  return known ? { verified, total } : null;
}

/**
 * One group's state. A group whose stage evidence is missing is unavailable, never complete, and
 * an active stage wins over a merely pending one.
 */
export function stageGroupState(workflow: TeamRunStageView | undefined, stages: readonly string[]): string {
  const states = stages.map(stage => workflow?.stages.find(item => item.stage === stage)?.state ?? "unavailable");
  if (states.includes("unavailable")) return "unavailable";
  if (states.every(state => state === "complete")) return "complete";
  for (const state of ["active", "awaiting-decision", "pending", "not-started"] as const) if (states.includes(state)) return state;
  return "unavailable";
}

export function compactTokens(run: TeamRun | undefined): string {
  const input = run?.usage.inputTokens.value, output = run?.usage.outputTokens.value;
  if (input == null || output == null) return DASH;
  const total = input + output;
  return total >= 1_000 ? `${Math.round(total / 1_000)}K` : String(total);
}

export function observedCost(run: TeamRun | undefined): string {
  const cost = run?.usage.costUsd.value;
  return cost == null ? DASH : `$${cost.toFixed(2)}`;
}

function clock(ts: string): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? ts : date.toISOString().slice(11, 19);
}

function verifiedLabel(task: TeamReviewView, dash: string): string {
  return task.criteria.verified === null || task.criteria.total === null
    ? dash : `${task.criteria.verified}/${task.criteria.total}`;
}

function Summary({ read }: { read?: TeamOwnerRead }) {
  const { t } = useTranslation();
  const running = read?.attempts.filter(attempt => attempt.state === "running").length;
  const blocked = read?.tasks.filter(task => task.queueState === "blocked").length;
  const cells = [
    { key: "overview.agentsActive", value: running == null ? DASH : String(running) },
    { key: "overview.tasks", value: read ? String(read.tasks.length) : DASH },
    { key: "overview.blocked", value: blocked == null ? DASH : String(blocked) },
    { key: "overview.tokens", value: compactTokens(read?.run) },
    { key: "overview.observedCost", value: observedCost(read?.run) },
  ];
  return <Card className="ui-summary" role="region" aria-label={t("overview.summary")}>
    <dl>{cells.map(cell => <div key={cell.key} data-summary={cell.key}>
      <dt>{t(cell.key as "overview.agentsActive")}</dt><dd>{cell.value}</dd>
    </div>)}</dl>
  </Card>;
}

function Progress({ read }: { read?: TeamOwnerRead }) {
  const { t } = useTranslation();
  const checks = verifiedChecks(read?.tasks ?? []);
  const share = checks && checks.total > 0 ? checks.verified / checks.total : null;
  return <Card className="ui-progress" role="region" aria-label={t("overview.progress")}>
    <div className="ui-progress-head">
      <strong>{checks ? t("overview.verified", { verified: checks.verified, total: checks.total }) : t("overview.verifiedUnknown")}</strong>
      {share !== null && <span className="ui-meter" role="img" aria-label={t("overview.verified", { verified: checks!.verified, total: checks!.total })}>
        <span style={{ width: `${Math.round(share * 100)}%` }} />
      </span>}
    </div>
    <ol className="ui-stages">{STAGE_GROUPS.map(group => {
      const state = stageGroupState(read?.workflow, group.stages);
      return <li key={group.label} data-stage-group={group.label} data-state={state}>
        <span className="ui-dot" data-state={state} aria-hidden="true" />
        <span>{t(group.label)}</span>
        <small>{t(`web.stageState.${state}` as "web.stageState.complete")}</small>
      </li>;
    })}</ol>
    <RunDetails read={read} />
  </Card>;
}

function RunDetails({ read }: { read?: TeamOwnerRead }) {
  const { t } = useTranslation();
  const run = read?.run, limits = run?.binding.limits;
  const facts = [
    { label: "web.runState", value: run ? t(`status.run.${run.state}`) : DASH },
    { label: "web.plan", value: run?.binding.planRef ?? DASH },
    { label: "web.binding", value: run?.bindingDigest ?? DASH },
    { label: "overview.sessionLimit", value: limits?.maxSessions ?? DASH },
    { label: "overview.activeLimit", value: limits ? `${limits.maxActiveMs / 1_000} s` : DASH },
    { label: "overview.retryLimit", value: run ? `${run.retriesUsed} / ${run.binding.limits.maxRetries}` : DASH },
    { label: "overview.reviewLimit", value: run ? `${run.reviewRoundsUsed} / ${run.binding.limits.maxReviewRounds}` : DASH },
  ];
  return <details className="ui-run-details">
    <summary>{t("overview.runDetails")}</summary>
    <p className="team-muted">{t("web.stageEvidence")}</p>
    <ol className="ui-stage-details">{Object.entries(STAGE_LABELS).map(([stage, label]) => {
      const state = read?.workflow.stages.find(item => item.stage === stage)?.state ?? "unavailable";
      return <li key={stage} data-run-stage={stage} data-state={state}>
        <span className="ui-dot" data-state={state} aria-hidden="true" /><span>{t(label)}</span>
        <small>{t(`web.stageState.${state}`)}</small>
      </li>;
    })}</ol>
    <dl className="team-facts">{facts.map(fact => <div key={fact.label}>
      <dt>{t(fact.label as "web.runState")}</dt><dd>{fact.value}</dd>
    </div>)}</dl>
    {run?.stateReason && <p className="team-muted">{run.stateReason}</p>}
  </details>;
}

function ActiveTasks({ read }: { read?: TeamOwnerRead }) {
  const { t } = useTranslation();
  const tasks = read?.tasks ?? [];
  return <Card className="ui-panel" role="region" aria-label={t("overview.activeTasks")}>
    <h2>{t("overview.activeTasks")}</h2>
    {!read ? <p className="team-muted">{t("value.unavailable")}</p>
      : tasks.length === 0 ? <p className="team-muted">{t("web.noTasks")}</p>
      : <table className="ui-table">
        <thead><tr>{(["overview.colId", "overview.colTask", "overview.colOwner", "overview.colState", "overview.colVerified"] as const)
          .map(key => <th key={key} scope="col">{t(key)}</th>)}</tr></thead>
        <tbody>{tasks.map(task => <tr key={task.qitemId} data-task-id={task.taskId}>
          <td><code>{task.taskId}</code></td>
          <td className="team-muted">{task.title ?? DASH}</td>
          <td>{t(`role.${task.role}`)}</td>
          <td><span className="ui-state" data-state={task.queueState}>{t(`status.queue.${task.queueState}`)}</span></td>
          <td>{verifiedLabel(task, DASH)}</td>
        </tr>)}</tbody>
      </table>}
  </Card>;
}

function Attention({ read, onOpenTasks, onOpenReviews }: { read?: TeamOwnerRead; onOpenTasks: () => void; onOpenReviews: () => void }) {
  const { t } = useTranslation();
  const approvals = read?.approvals.filter(item => item.state === "pending") ?? [];
  const blocked = read?.tasks.filter(task => task.queueState === "blocked") ?? [];
  return <Card className="ui-panel" role="region" aria-label={t("overview.needsAttention")}>
    <h2>{t("overview.needsAttention")}{read && approvals.length + blocked.length > 0 && <span className="ui-count">{approvals.length + blocked.length}</span>}</h2>
    {!read ? <p className="team-muted">{t("value.unavailable")}</p>
      : approvals.length + blocked.length === 0 ? <p className="team-muted">{t("overview.noAttention")}</p>
      : <ul className="ui-attention">
        {approvals.map(item => <li key={item.id} data-attention="approval">
          <TriangleAlert aria-hidden="true" />
          <span><strong>{t("overview.pendingApproval")}</strong><small>{item.action}{typeof item.payload.reason === "string" ? ` · ${item.payload.reason}` : ""}</small></span>
        </li>)}
        {blocked.map(task => <li key={task.qitemId} data-attention="blocked">
          <TriangleAlert aria-hidden="true" />
          <span><strong><code>{task.taskId}</code> {t("status.queue.blocked")}</strong><small>{t(`role.${task.role}`)}</small></span>
        </li>)}
      </ul>}
    <div className="ui-decision-actions">
      {approvals.length > 0 && <Button variant="outline" onClick={onOpenReviews}>{t("overview.viewReviews")}<ArrowRight aria-hidden="true" /></Button>}
      <Button variant="ghost" onClick={onOpenTasks}>{t("overview.viewAllTasks")}<ArrowRight aria-hidden="true" /></Button>
    </div>
  </Card>;
}

function Fleet({ read }: { read?: TeamOwnerRead }) {
  const { t } = useTranslation();
  const latest = new Map<string, NonNullable<TeamOwnerRead["attempts"]>[number]>();
  for (const attempt of read?.attempts ?? []) latest.set(attempt.role, attempt);
  return <Card className="ui-panel" role="region" aria-label={t("overview.fleet")}>
    <h2>{t("overview.fleet")}</h2>
    {!read ? <p className="team-muted">{t("value.unavailable")}</p>
      : latest.size === 0 ? <p className="team-muted">{t("web.noAttempts")}</p>
      : <ul className="ui-fleet">{(["lead", "implementer", "reviewer"] as const).filter(role => latest.has(role)).map(role => {
        const attempt = latest.get(role)!;
        return <li key={role} data-fleet-role={role}>
          <span className="ui-dot" data-state={attempt.state} aria-hidden="true" />
          <strong>{t(`role.${role}`)}</strong>
          <span className="team-muted">{attempt.provider}</span>
          <span className="ui-state" data-state={attempt.state}>{t(`status.attempt.${attempt.state}`)}</span>
        </li>;
      })}</ul>}
  </Card>;
}

function RecentEvents({ read }: { read?: TeamOwnerRead }) {
  const { t } = useTranslation();
  const logs = [...(read?.logs ?? [])].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, 4);
  return <Card className="ui-panel" role="region" aria-label={t("overview.recentEvents")}>
    <h2>{t("overview.recentEvents")}</h2>
    {!read ? <p className="team-muted">{t("value.unavailable")}</p>
      : logs.length === 0 ? <p className="team-muted">{t("web.noEvents")}</p>
      : <ul className="ui-events">{logs.map((log, index) => <li key={log.streamItemId ?? `${log.ts}-${index}`}>
        <time dateTime={log.ts}>{clock(log.ts)}</time>
        <span>{log.taskId && <code>{log.taskId} </code>}{log.body}</span>
        {log.truncated && <small>{t("web.truncated")}</small>}
      </li>)}</ul>}
  </Card>;
}

export function Overview({ read, run, onInspect, onOpenTasks, onOpenReviews }: {
  read?: TeamOwnerRead; run?: TeamRun; now: number; onInspect: () => void; onOpenTasks: () => void; onOpenReviews: () => void;
}) {
  const { t } = useTranslation();
  return <div className="ui-overview">
    <header className="ui-page-head">
      <div>
        <h1>{t("nav.overview")}</h1>
        <p className="ui-subtitle">{run ? <><code>{run.rigId}</code> / <code>{run.id}</code></> : DASH}</p>
      </div>
      <div className="ui-page-actions">
        <Button className="ui-primary" onClick={onInspect}>{t("overview.inspectRun")}</Button>
      </div>
    </header>
    <Summary read={read} />
    <Progress read={read} />
    <div className="ui-overview-grid">
      <ActiveTasks read={read} />
      <Attention read={read} onOpenTasks={onOpenTasks} onOpenReviews={onOpenReviews} />
    </div>
    <div className="ui-overview-foot">
      <Fleet read={read} />
      <RecentEvents read={read} />
    </div>
  </div>;
}
