import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TeamAttemptView, TeamOwnerRead, TeamReplayEvent, TeamReviewView, TeamRun } from "@openrig/daemon/team-control";
import { Button } from "../../components/ui/button.js";
import { Card } from "../../components/ui/card.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs.js";
import { useOwnerSession } from "../../hooks/useOwnerSession.js";
import { isFinished, useTeamResult } from "../../hooks/useTeamResult.js";
import { BottomPanel, type TerminalTarget } from "../bottom-panel.js";
import { DiffView } from "../diff-view.js";
import { OwnerDialog } from "../decision-dialog.js";
import { compactTokens } from "../overview.js";

/**
 * Slice B — Workspace / Focus.
 *
 * One agent at a time: who it is, what state it is in, what it did, and what it changed. The
 * layout switch keeps Grid and Split visible but disabled, because the design places them later
 * and a control that silently does nothing is worse than one that says so.
 *
 * Everything the read model does not publish is an em dash. In particular a token count, an
 * elapsed time and a check count are each shown only when a durable row carries them.
 */

const DASH = "—";
export type FocusTab = "execution" | "changes" | "tools" | "output";

/** The run's accounted active time, as the mockup's elapsed cell shows it. */
export function elapsedLabel(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return DASH;
  const total = Math.floor(ms / 1_000);
  const hours = Math.floor(total / 3_600), minutes = Math.floor((total % 3_600) / 60), seconds = total % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** The latest attempt that speaks for a task, so the identity row names one runtime. */
export function attemptFor(attempts: readonly TeamAttemptView[] | undefined, task: TeamReviewView | undefined): TeamAttemptView | undefined {
  if (!task) return undefined;
  return [...(attempts ?? [])].filter(attempt => attempt.qitemId === task.qitemId || attempt.taskId === task.taskId).at(-1);
}

/** The task the screen opens on: the one working now, else the first published task. */
export function defaultTask(tasks: readonly TeamReviewView[] | undefined, attempts: readonly TeamAttemptView[] | undefined): TeamReviewView | undefined {
  const list = tasks ?? [];
  const running = new Set((attempts ?? []).filter(attempt => attempt.state === "running").map(attempt => attempt.qitemId));
  return list.find(task => running.has(task.qitemId)) ?? list[0];
}

/** "N of M checks verified", or the sentence that says no record exists. */
export function checksLabel(task: TeamReviewView | undefined, translate: (key: string, values?: Record<string, number>) => string): string {
  const checked = task?.criteria.verified, total = task?.criteria.total;
  return checked == null || total == null ? translate("overview.verifiedUnknown") : translate("overview.verified", { verified: checked, total });
}

function Identity({ task, attempt, run, available, onPause, onStop }: {
  task: TeamReviewView | undefined; attempt: TeamAttemptView | undefined; run: TeamRun | undefined;
  available: boolean; onPause: (trigger: HTMLElement) => void; onStop: (trigger: HTMLElement) => void;
}) {
  const { t } = useTranslation();
  return <Card className="ui-identity" role="region" aria-label={t("workspace.identity")}>
    <div className="ui-identity-who">
      <h2>{task ? t(`role.${task.role}`) : DASH}</h2>
      <p className="team-muted">{attempt ? attempt.provider : DASH} · <code>{task?.taskId ?? DASH}</code></p>
    </div>
    <dl className="ui-identity-facts">
      <div><dt>{t("workspace.runtime")}</dt><dd>{attempt ? attempt.provider : DASH}</dd></div>
      <div><dt>{t("workspace.state")}</dt><dd>{task ? t(`status.queue.${task.queueState}`) : DASH}</dd></div>
      <div><dt>{t("workspace.elapsed")}</dt><dd>{elapsedLabel(run?.usage.activeMs)}</dd></div>
      <div><dt>{t("workspace.tokens")}</dt><dd>{compactTokens(run)}</dd></div>
    </dl>
    <div className="ui-identity-actions">
      <Button variant="outline" disabled={!available || !run} onClick={event => onPause(event.currentTarget)}>{t("workspace.pause")}</Button>
      <Button variant="outline" disabled={!available || !run} onClick={event => onStop(event.currentTarget)}>{t("workspace.stop")}</Button>
    </div>
  </Card>;
}

/** The selected agent's own log lines and replay events, newest last. */
function Execution({ read, replay, taskId }: { read?: TeamOwnerRead; replay?: TeamReplayEvent[]; taskId: string | undefined }) {
  const { t } = useTranslation();
  const logs = (read?.logs ?? []).filter(log => !taskId || log.taskId === taskId).slice(0, 20);
  const events = (replay ?? []).filter(event => !taskId || event.taskId === null || event.taskId === taskId).slice(-10);
  return <div className="ui-execution">
    <h3>{t("workspace.recentActivity")}</h3>
    {logs.length === 0 ? <p className="team-muted">{t("web.noLogs")}</p>
      : <ul className="ui-events">{logs.map((log, index) => <li key={log.streamItemId ?? `${log.ts}-${index}`}>
        <time dateTime={log.ts}>{log.ts.slice(11, 19)}</time>
        <span>{log.exitOutcome && <span className="ui-state" data-state={log.exitOutcome}>{t(`status.queue.${log.exitOutcome}`)} </span>}{log.body}</span>
        {log.truncated && <small>{t("web.truncated")}</small>}
      </li>)}</ul>}
    <h3>{t("workspace.events")}</h3>
    {events.length === 0 ? <p className="team-muted">{t("web.noEvents")}</p>
      : <ul className="ui-events">{events.map(event => <li key={event.seq}>
        <time dateTime={event.createdAt}>{event.createdAt.slice(11, 19)}</time>
        <span><code>{event.action ?? event.type}</code>{event.body && <small>{event.body}</small>}</span>
      </li>)}</ul>}
  </div>;
}

/** The candidate's diff once the task has an outcome; until then, the honest empty state. */
function Changes({ runId, task }: { runId: string; task: TeamReviewView | undefined }) {
  const { t } = useTranslation();
  const finished = !!task && isFinished(task.queueState);
  const result = useTeamResult(runId, task?.taskId ?? null, finished);
  if (!task) return <p className="team-muted">{t("workspace.noTask")}</p>;
  if (!finished) return <div className="ui-empty-state" data-testid="changes-pending">
    <strong>{t("workspace.resultPendingTitle")}</strong>
    <p className="team-muted">{t("workspace.resultPending")}</p>
  </div>;
  if (result.isPending) return <p className="team-muted" role="status">{t("web.loading")}</p>;
  if (result.isError) return <p className="team-muted" role="alert">{t("web.resultUnavailable")}</p>;
  return <>
    <p className="team-muted ui-diff-meta">{t("web.candidate")}: <code>{result.data.manifestDigest}</code></p>
    <DiffView patch={result.data.patch} label={t("workspace.changes")} empty={t("diff.empty")} />
  </>;
}

/** The task's own output lines: what it printed, never a summary of what it meant. */
function Output({ read, taskId }: { read?: TeamOwnerRead; taskId: string | undefined }) {
  const { t } = useTranslation();
  const logs = (read?.logs ?? []).filter(log => log.taskId === taskId);
  if (logs.length === 0) return <p className="team-muted">{t("workspace.noOutput")}</p>;
  return <pre className="ui-output" tabIndex={0} aria-label={t("workspace.output")}>{logs.map(log => log.body).join("\n")}</pre>;
}

export function WorkspaceFocus({ read, runId, attempts, available, replay, onPause, onStop, evidence }: {
  read?: TeamOwnerRead; runId: string; attempts?: TeamAttemptView[]; available: boolean;
  replay?: TeamReplayEvent[]; onPause: (trigger: HTMLElement) => void; onStop: (trigger: HTMLElement) => void;
  evidence: { tab: string; onTab: (value: string) => void; target: TerminalTarget; onTarget: (target: TerminalTarget) => void };
}) {
  const { t } = useTranslation();
  const tasks = read?.tasks ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<FocusTab>("execution");
  const task = useMemo(() => tasks.find(item => item.qitemId === selectedId) ?? defaultTask(tasks, attempts), [tasks, attempts, selectedId]);
  const attempt = attemptFor(attempts, task);
  return <div className="ui-focus">
    <div className="ui-focus-bar">
      <label className="ui-agent-select">{t("workspace.agent")}
        <select value={task?.qitemId ?? ""} onChange={event => setSelectedId(event.target.value)}>
          {tasks.length === 0 && <option value="">{t("workspace.noTask")}</option>}
          {tasks.map(item => <option key={item.qitemId} value={item.qitemId}>
            {t(`role.${item.role}`)} · {item.taskId}{item.title ? ` · ${item.title}` : ""}
          </option>)}
        </select>
      </label>
    </div>
    <Identity task={task} attempt={attempt} run={read?.run} available={available} onPause={onPause} onStop={onStop} />
    <Tabs value={tab} onValueChange={value => setTab(value as FocusTab)}>
      <TabsList aria-label={t("workspace.tabs")}>
        <TabsTrigger value="execution">{t("workspace.execution")}</TabsTrigger>
        <TabsTrigger value="changes">{t("workspace.changes")}</TabsTrigger>
        <TabsTrigger value="tools">{t("workspace.tools")}</TabsTrigger>
        <TabsTrigger value="output">{t("workspace.output")}</TabsTrigger>
      </TabsList>
      <TabsContent value="execution"><Execution read={read} replay={replay} taskId={task?.taskId} /></TabsContent>
      <TabsContent value="changes"><Changes runId={runId} task={task} /></TabsContent>
      <TabsContent value="tools">
        <BottomPanel tab={evidence.tab} onTab={evidence.onTab} read={read} available={available}
          target={evidence.target} onTarget={evidence.onTarget} />
      </TabsContent>
      <TabsContent value="output"><Output read={read} taskId={task?.taskId} /></TabsContent>
    </Tabs>
    <footer className="ui-checks" data-testid="focus-checks">
      <span className="ui-dot" data-state={task?.criteria.verified != null && task.criteria.total != null && task.criteria.verified === task.criteria.total ? "complete" : "unknown"} aria-hidden="true" />
      <span>{checksLabel(task, (key, values) => t(key as "overview.verified", values))}</span>
    </footer>
  </div>;
}

/** Pause and Stop both ask first; the question names the run and what the action will do. */
export function RunControlDialog({ action, run, trigger, available, onClose }: {
  action: "pause" | "stop" | null; run: TeamRun | undefined; trigger: HTMLElement | null; available: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { request } = useOwnerSession();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (!action || !run) return null;
  const submit = async () => {
    setBusy(true);
    const payload = action === "pause" ? {} : { reason: t("workspace.stopReason") };
    try {
      const receipt = await request<{ status: string; reason: string | null }>(
        `/runs/${encodeURIComponent(run.id)}/${action === "pause" ? "pause" : "cancel"}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({ protocolVersion: "1.0", runId: run.id, actionId: run.id,
            expectedEntityVersion: run.entityVersion, idempotencyKey: crypto.randomUUID(), payload }) });
      setMessage(receipt.status === "denied" ? "team.denied" : receipt.status === "conflict" ? "team.conflict"
        : receipt.status === "observed" ? "team.observed" : "team.requested");
    } catch (error) {
      setMessage((error as { status?: number }).status === 409 ? "team.conflict" : "team.unacknowledged");
    } finally { setBusy(false); }
  };
  return <OwnerDialog title={t(action === "pause" ? "workspace.pauseTitle" : "workspace.stopTitle")}
    description={t(action === "pause" ? "workspace.pauseHelp" : "workspace.stopHelp")}
    trigger={trigger} onClose={onClose}>
    <p className="team-muted"><code>{run.id}</code> · {t(`status.run.${run.state}`)}</p>
    {message && <p role={["team.conflict", "web.unacknowledged", "team.denied"].includes(message) ? "alert" : "status"}>{t(message as "team.observed")}</p>}
    <Button variant="outline" disabled={!available || busy || message !== null} onClick={() => void submit()}>
      {t(action === "pause" ? "workspace.pause" : "workspace.stop")}
    </Button>
  </OwnerDialog>;
}
