import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { ControlReceipt } from "@openrig/daemon/team-control";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { OwnerReadError, useOwnerSession } from "../hooks/useOwnerSession.js";

/**
 * MVP — the owner's one completion action, on the Tasks screen.
 *
 * An agent cannot complete a task: the outcome is an owner observation, and R18 keeps
 * acceptance on validated evidence. So this panel shows what the daemon observed — the attempt
 * it saw stop, and what it could verify about the candidate — and offers exactly two decisions
 * over that: mark the task done, or mark it failed. It invents no evidence: the button that
 * records `done` stays disabled until the daemon's own check passes, and the reasons are shown
 * as the daemon stated them.
 *
 * A reviewer task's completion is a review, so its findings are its evidence. They are pasted
 * here as the reviewer's JSON block and travel unchanged; the daemon's own parser is what
 * accepts or refuses them.
 */

export interface CompletionEvidence {
  validated: boolean; manifestDigest: string | null; base: string | null; baseIdentifier: string | null;
  fileCount: number; changedPaths: string[]; outsideAssignment: string[]; reasons: string[];
}

export interface TaskCompletion {
  taskId: string; role: "lead" | "implementer" | "reviewer"; subjectTaskId: string;
  queueState: string | null; taskVersion: number; actorSession: string | null;
  attempt: { attemptId: string; entityVersion: number; state: string; observed: boolean } | null;
  openAttempts: number; blockedReason: string | null; findingsRequired: boolean;
  evidence: CompletionEvidence;
}

type Message = "" | "recorded" | "conflict" | "unknown" | "error" | "findingsInvalid";

/** The three attempt states the control publishes, narrowed so the catalog key stays typed. */
function attemptStateKey(state: string): "status.attempt.running" | "status.attempt.stopped" | "status.attempt.unknown" {
  return state === "running" || state === "stopped" ? `status.attempt.${state}` : "status.attempt.unknown";
}

export function CompletionPanel({ runId, taskId, onRecorded }: {
  runId: string; taskId: string; onRecorded?: () => void;
}) {
  const { t } = useTranslation(), session = useOwnerSession(), cache = useQueryClient();
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<Message>("");
  const [findings, setFindings] = useState("");
  const [receipt, setReceipt] = useState<{ reviewTaskId?: string; reworkTaskId?: string }>({});
  const query = useQuery({
    queryKey: ["team", runId, "completion", taskId], retry: false,
    enabled: session.paired && !!runId && !!taskId,
    queryFn: async ({ signal }) => {
      const { completion } = await session.request<{ completion: TaskCompletion }>(
        `/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/completion`, { signal });
      return completion;
    },
  });
  const completion = query.data;
  // A task that already has a terminal outcome has nothing left to record.
  const terminal = !!completion?.queueState && !["pending", "in-progress", "blocked"].includes(completion.queueState);
  const record = async (state: "done" | "failed") => {
    if (!completion?.attempt || busy) return;
    let parsed: unknown;
    if (findings.trim()) {
      try { parsed = JSON.parse(findings); } catch { setMessage("findingsInvalid"); return; }
    }
    if (completion.findingsRequired && state === "done" && parsed === undefined) { setMessage("findingsInvalid"); return; }
    setBusy(true);
    try {
      const run = await session.request<{ run: { entityVersion: number } }>(`/runs/${encodeURIComponent(runId)}`);
      const request = { protocolVersion: "1.0", runId, actionId: completion.taskId, expectedEntityVersion: run.run.entityVersion,
        idempotencyKey: crypto.randomUUID(),
        payload: { expectedTaskVersion: completion.taskVersion, state,
          ...(state === "done" ? { closureReason: "no-follow-on" } : {}),
          actorSession: completion.actorSession, attemptId: completion.attempt.attemptId,
          expectedAttemptVersion: completion.attempt.entityVersion,
          evidence: { ...completion.evidence, ...(parsed === undefined ? {} : { findings: parsed }) } } };
      const result = await session.request<ControlReceipt<unknown> & { reviewTaskId?: string; reworkTaskId?: string }>(
        `/runs/${encodeURIComponent(runId)}/tasks/outcome`, { method: "POST",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
      if (result.status === "denied") throw new OwnerReadError(403, result.reason ?? "control_denied");
      setMessage("recorded");
      setReceipt({ reviewTaskId: result.reviewTaskId, reworkTaskId: result.reworkTaskId });
      await cache.invalidateQueries({ queryKey: ["team", runId] });
      onRecorded?.();
    } catch (error) {
      if (error instanceof OwnerReadError && error.status < 500) setMessage(error.status === 409 ? "conflict" : "error");
      else setMessage("unknown");
    } finally { setBusy(false); }
  };
  const evidence = completion?.evidence;
  return <Card className="team-card" role="region" aria-label={t("completion.title")}>
    <h2>{t("completion.title")}</h2>
    {!session.paired ? <p className="team-muted">{t("workspace.controlUnavailable")}</p>
      : query.isPending ? <p className="team-muted">{t("completion.reading")}</p>
      : query.isError ? <p className="team-muted">{t("completion.unavailable")}</p>
      : completion && <>
        <dl className="team-detail-facts">
          <div><dt>{t("completion.attempt")}</dt><dd>{completion.attempt
            ? <><code>{completion.attempt.attemptId}</code> · {t(attemptStateKey(completion.attempt.state))}</>
            : t("completion.noAttempt")}</dd></div>
          <div><dt>{t("completion.candidate")}</dt><dd>{evidence?.manifestDigest ?? t("value.unavailable")}</dd></div>
          <div><dt>{t("completion.files")}</dt><dd>{evidence?.fileCount ?? 0}</dd></div>
          <div><dt>{t("completion.validated")}</dt><dd>{evidence?.validated ? t("completion.yes") : t("completion.no")}</dd></div>
        </dl>
        {evidence && evidence.changedPaths.length > 0 && <>
          <h3>{t("completion.changedPaths")}</h3>
          <ul>{evidence.changedPaths.map(path => <li key={path}><code>{path}</code></li>)}</ul>
        </>}
        {evidence && evidence.reasons.length > 0 && <>
          <h3>{t("completion.reasons")}</h3>
          <ul>{evidence.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
        </>}
        {completion.findingsRequired && <label>{t("completion.findings")}
          <textarea value={findings} disabled={busy || terminal} rows={6} style={{ width: "100%", fontFamily: "monospace" }}
            onChange={event => setFindings(event.target.value)} />
        </label>}
        {completion.blockedReason && <p role="status">{completion.blockedReason}</p>}
        {terminal ? <p role="status">{t("completion.alreadyRecorded")}</p> : <>
          <Button variant="outline" disabled={busy || !!completion.blockedReason || !evidence?.validated}
            onClick={() => { void record("done"); }}>{t("completion.markDone")}</Button>
          <Button variant="outline" disabled={busy || !!completion.blockedReason}
            onClick={() => { void record("failed"); }}>{t("completion.markFailed")}</Button>
        </>}
        {message && <p role={message === "recorded" ? "status" : "alert"}>{t(`completion.${message}`)}</p>}
        {receipt.reviewTaskId && <p role="status">{t("completion.reviewCreated", { taskId: receipt.reviewTaskId })}</p>}
        {receipt.reworkTaskId && <p role="status">{t("completion.reworkOpened", { taskId: receipt.reworkTaskId })}</p>}
      </>}
  </Card>;
}
