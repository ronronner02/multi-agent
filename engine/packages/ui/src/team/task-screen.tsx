import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { ControlReceipt, TeamOwnerRead, TeamSeatView } from "@openrig/daemon/team-control";
import { useOwnerSession } from "../hooks/useOwnerSession.js";
import { DiffView } from "./diff-view.js";
import { relativeTime, seatLabel, stateLabel, stateOf, taskName } from "./display.js";
import { Check } from "./glyphs.js";

interface TaskResult { patch: string }

/** The completion read the daemon already serves, narrowed to what the override sends back. */
interface TaskCompletion {
  taskId: string; qitemId: string; queueState: string | null; taskVersion: number; actorSession: string | null;
  attempt: { attemptId: string; entityVersion: number; state: string } | null;
  findingsRequired: boolean;
  evidence: Record<string, unknown>;
}

/**
 * U10 — one task, read-only.
 *
 * The diff is the subject: the file strip runs along the top so the code keeps the width, and
 * the review and the attempts sit in a band under it. The owner does not fix code from here, so
 * the screen has no primary action. One quiet override stays, because U4's daemon-recorded
 * outcomes have not landed yet: until they do, an implementer task can be closed from here the
 * way `rig team done` closes it.
 */
export function TaskScreen({ read, runId, taskId, seats, onBack }: {
  read?: TeamOwnerRead; runId: string; taskId: string; seats: readonly TeamSeatView[]; onBack: () => void;
}) {
  const { t } = useTranslation();
  const session = useOwnerSession();
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const task = (read?.tasks ?? []).find(item => item.taskId === taskId);
  const result = useQuery({
    queryKey: ["team", runId, "task", taskId, "result"],
    enabled: session.paired && !!runId && !!taskId, retry: false,
    queryFn: async ({ signal }) => (await session.request<{ result: TaskResult }>(
      `/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/result`, { signal })).result,
  });
  const completion = useQuery({
    queryKey: ["team", runId, "task", taskId, "completion"],
    enabled: session.paired && !!runId && !!taskId, retry: false,
    queryFn: async ({ signal }) => (await session.request<{ completion: TaskCompletion }>(
      `/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/completion`, { signal })).completion,
  });

  if (!task) return <div className="page"><p className="muted">{t("value.unavailable")}</p></div>;

  const state = stateOf(task);
  const attempts = (read?.attempts ?? []).filter(attempt => attempt.taskId === task.taskId)
    .slice().sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const now = Date.now();
  const open = completion.data && ["pending", "in-progress", "blocked"].includes(completion.data.queueState ?? "");
  const canClose = !!open && !!completion.data?.attempt && !completion.data.findingsRequired && state !== "done";

  const markDone = async () => {
    const entry = completion.data;
    if (!entry?.attempt || busy) return;
    setBusy(true); setFailed(false);
    try {
      const run = await session.request<{ run: { entityVersion: number } }>(`/runs/${encodeURIComponent(runId)}`);
      const receipt = await session.request<ControlReceipt<unknown>>(`/runs/${encodeURIComponent(runId)}/tasks/outcome`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protocolVersion: "1.0", runId, actionId: entry.qitemId,
          expectedEntityVersion: run.run.entityVersion, idempotencyKey: crypto.randomUUID(),
          payload: { expectedTaskVersion: entry.taskVersion, state: "done", closureReason: "no-follow-on",
            actorSession: entry.actorSession, attemptId: entry.attempt.attemptId,
            expectedAttemptVersion: entry.attempt.entityVersion, evidence: entry.evidence } }),
      });
      if (receipt.status === "denied") throw new Error(receipt.reason ?? "denied");
      await cache.invalidateQueries();
    } catch { setFailed(true); } finally { setBusy(false); }
  };

  return <main className="detail">
    <div className="detail-head">
      <h1 className="display">{taskName(task, t)}</h1>
      <div className="detail-meta">
        <span className="state" data-state={state}>{stateLabel(state, t)}</span>
        <span>{seatLabel(task.role, seats, t)}</span>
        {canClose && <button className="btn btn-quiet" style={{ marginLeft: "auto", fontSize: 13 }} disabled={busy}
          onClick={() => void markDone()}>{t("team.task.markDone")}</button>}
        {failed && <span role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>{t("web.error")}</span>}
      </div>
    </div>

    <div className="detail-grid">
      <section aria-label={t("team.task.diff")}>
        {result.isPending ? <p className="muted">{t("value.unavailable")}</p>
          : result.isError || !result.data?.patch
            ? <p className="muted">{t("team.task.noDiff")}</p>
            : <DiffView patch={result.data.patch} empty={t("team.task.noDiff")} />}
      </section>

      <div className="detail-foot">
        <section className="review">
          <h2>{t("team.task.review")}</h2>
          {!task.reviewAvailable || task.verdicts.length === 0
            ? <p className="muted">{t("team.task.noReview")}</p>
            : task.verdicts.map(verdict => <div key={verdict.round} className="finding">
              <div className="finding-head">
                <span className="verdict-mark" data-verdict={verdict.verdict}>
                  {verdict.verdict === "approved" ? <Check /> : null}
                  {t(`team.task.verdict.${verdict.verdict}` as "team.task.verdict.approved")}
                </span>
                <span className="sev">{t("team.task.roundN", { round: verdict.round })}</span>
                <span className="loc">{relativeTime(verdict.recordedAt, now, t)}</span>
              </div>
              <p>
                {t("team.task.findingCount", { count: verdict.findings })}
                {verdict.blocking > 0 ? ` · ${t("team.task.blockingCount", { count: verdict.blocking })}` : ""}
              </p>
            </div>)}
        </section>

        <section className="attempts">
          <h2>{t("team.task.attempts")}</h2>
          {attempts.length === 0 ? <p className="muted">{t("value.unavailable")}</p>
            : attempts.map((attempt, index) => <div key={attempt.attemptId} className="attempt">
              <span>{t("team.task.attemptN", { round: index + 1 })}</span>
              <span className="result" data-ok={attempt.failure === null}>
                {attempt.failure ? t("team.attempt.failed") : t("team.attempt.done")}
              </span>
              <span className="when">{attempt.provider === "codex" ? t("team.client.codex") : t("team.client.claude-code")} · {relativeTime(attempt.createdAt, now, t)}</span>
            </div>)}
        </section>
      </div>
    </div>
  </main>;
}