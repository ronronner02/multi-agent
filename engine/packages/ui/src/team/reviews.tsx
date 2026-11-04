import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ControlReceipt, TeamApproval, TeamOwnerRead, TeamReviewView } from "@openrig/daemon/team-control";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { useOwnerSession } from "../hooks/useOwnerSession.js";
import { isFinished, useTeamResult } from "../hooks/useTeamResult.js";
import { DiffView } from "./diff-view.js";
import { OwnerDialog } from "./decision-dialog.js";
import { fullDigest, shortDigest } from "./digest.js";

/**
 * Slice B — Reviews.
 *
 * The candidate's diff is the subject; the inspector beside it says what the review evidence
 * actually shows. Findings come only from a recorded review round, so a task with no review says
 * so instead of drawing an empty finding list that could read as a clean pass.
 *
 * The gates are three verdicts the read model publishes (tests, review, integration) plus the
 * delivery decision, and each is `passed`, `waiting` or `unknown`. Approval is enabled only when
 * the task's own pending decision exists, because Approve and Request changes are that decision's
 * two outcomes — a button that invents a decision the daemon never asked for is not a control.
 */

export type GateState = "passed" | "waiting" | "unknown";
export type GateKey = "tests" | "review" | "integration" | "delivery";
export interface Gate { key: GateKey; state: GateState; detail: string | null }

/** The candidate under review: the reviewer's own link when it has one, else the first task. */
export function reviewCandidate(tasks: readonly TeamReviewView[] | undefined): TeamReviewView | undefined {
  const list = tasks ?? [];
  return list.find(task => task.currentCandidateDigest !== null) ?? list.find(task => task.role === "reviewer") ?? list[0];
}

/**
 * The four gates, from the read model's own evidence.
 *
 * Tests and integration read the acceptance record, which is the run's validated integration
 * result; the review gate reads the folded round evidence. Nothing here turns "no record" into a
 * pass: an unrecorded gate is `unknown`, and a recorded failing acceptance is `waiting`, because
 * the reviewer's change request is the work still outstanding.
 */
export function reviewGates(task: TeamReviewView | undefined, approvals: readonly TeamApproval[]): Gate[] {
  const acceptance = task?.acceptance;
  const review: Gate = !task || !task.reviewAvailable ? { key: "review", state: "unknown", detail: null }
    : task.openP0P1 > 0 ? { key: "review", state: "waiting", detail: null }
      : { key: "review", state: "passed", detail: null };
  const tests: Gate = acceptance ? { key: "tests", state: acceptance.passed ? "passed" : "waiting", detail: acceptance.reason }
    : { key: "tests", state: "unknown", detail: null };
  const integration: Gate = acceptance ? { key: "integration", state: acceptance.passed ? "passed" : "unknown", detail: null }
    : { key: "integration", state: "unknown", detail: null };
  const delivery = approvals.find(approval => ["merge", "pr-create", "release"].includes(approval.action));
  return [tests, review, integration, {
    key: "delivery",
    state: delivery ? (delivery.state === "approved" ? "passed" : delivery.state === "pending" ? "waiting" : "unknown") : "unknown",
    detail: null,
  }];
}

/** The pending decision that governs this task, if the run asked for one. */
export function taskDecision(approvals: readonly TeamApproval[], task: TeamReviewView | undefined): TeamApproval | undefined {
  if (!task) return undefined;
  return approvals.find(approval => approval.state === "pending"
    && (approval.payload.taskId === task.taskId || approval.payload.taskId === task.qitemId));
}

/**
 * What the review record says. The read model publishes the round count and the open P0/P1 count,
 * not each finding's text, so this names both and never invents a finding to fill the panel.
 *
 * C2 adds the run's own review rounds: each one names the reviewer task that produced it, the
 * verdict the loop acted on, and how many findings were blocking. A task with no recorded round
 * still says so rather than drawing an empty table that could read as a clean pass.
 */
function Finding({ task }: { task: TeamReviewView | undefined }) {
  const { t } = useTranslation();
  if (!task) return <p className="team-muted">{t("reviews.noCandidate")}</p>;
  if (!task.reviewAvailable) return <p className="team-muted" data-testid="no-findings">{t("reviews.noFindings")}</p>;
  return <>
    {task.openP0P1 === 0 && <p className="team-muted" data-testid="no-findings">{t("reviews.noOpenFindings")}</p>}
    <dl className="ui-facts">
      <div><dt>{t("web.reviewRounds")}</dt><dd>{task.rounds}</dd></div>
      <div><dt>{t("web.openP0P1")}</dt><dd data-testid="open-p0p1">{task.openP0P1}</dd></div>
      <div><dt>{t("reviews.candidateDigest")}</dt><dd><code title={fullDigest(task.currentCandidateDigest)}>{shortDigest(task.currentCandidateDigest)}</code></dd></div>
    </dl>
    {task.verdicts.length > 0 && <ul className="ui-verdicts" aria-label={t("reviews.rounds")}>
      {task.verdicts.map(round => <li key={`${round.reviewerTaskId}:${round.round}`} data-round={round.round}
        data-verdict={round.verdict} data-testid={`review-verdict-${round.round}`}>
        <code>{round.reviewerTaskId}</code>
        <span>{t(round.verdict === "approved" ? "reviews.verdictApproved" : "reviews.verdictChangesRequired")}</span>
        <span className="team-muted">{t("reviews.blockingFindings", { count: round.blocking })}</span>
      </li>)}
    </ul>}
  </>;
}

export function ReviewsScreen({ read, runId, available, refresh }: {
  read?: TeamOwnerRead; runId: string; available: boolean; refresh: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const { request } = useOwnerSession();
  const task = reviewCandidate(read?.tasks);
  const gates = reviewGates(task, read?.approvals ?? []);
  const decision = taskDecision(read?.approvals ?? [], task);
  const finished = !!task && isFinished(task.queueState);
  const result = useTeamResult(runId, task?.taskId ?? null, finished);
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  const [choice, setChoice] = useState<"approved" | "rejected" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sent = useRef(false);

  // The read model is the authority on the decision's outcome: a submitted decision closes the
  // dialog only once the approval is no longer pending, never on the POST's own say-so.
  useEffect(() => {
    if (sent.current && decision === undefined && choice !== null) { sent.current = false; setChoice(null); }
  }, [decision, choice]);

  const submit = async (action: "approved" | "rejected") => {
    if (!decision || !read) return;
    setBusy(true);
    try {
      const receipt = await request<ControlReceipt>(`/runs/${encodeURIComponent(read.runId)}/approvals/decide`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ protocolVersion: "1.0", runId: read.runId, actionId: decision.id,
          expectedEntityVersion: read.run.entityVersion, idempotencyKey: crypto.randomUUID(),
          payload: { approvalVersion: decision.entityVersion, decision: action } }),
      });
      setMessage(receipt.status === "denied" ? "team.denied" : receipt.status === "conflict" ? "team.conflict"
        : receipt.status === "observed" ? "team.observed" : "team.requested");
      sent.current = true;
      try { await refresh(); } catch { setMessage("team.refreshUnavailable"); }
    } catch (error) {
      setMessage((error as { status?: number }).status === 409 ? "team.conflict" : "team.unacknowledged");
    } finally { setBusy(false); }
  };

  return <div className="ui-reviews">
    <header className="ui-page-head">
      <div>
        <h1>{t("nav.reviews")}</h1>
        <p className="ui-subtitle">{t("reviews.subtitle")} / <code>{task?.taskId ?? "—"}</code></p>
      </div>
    </header>
    <div className="ui-reviews-body">
      <section className="ui-reviews-main" aria-label={t("reviews.candidate")}>
        {!task ? <p className="team-muted">{t("reviews.noCandidate")}</p>
          : !finished ? <div className="ui-empty-state" data-testid="review-pending">
            <strong>{t("reviews.candidatePendingTitle")}</strong>
            <p className="team-muted">{t("reviews.candidatePending")}</p>
          </div>
          : result.isPending ? <p className="team-muted" role="status">{t("web.loading")}</p>
          : result.isError ? <p className="team-muted" role="alert">{t("web.resultUnavailable")}</p>
          : <DiffView patch={result.data.patch} label={t("reviews.candidate")} empty={t("diff.empty")} />}
      </section>
      <aside className="ui-reviews-inspector" aria-label={t("reviews.inspector")}>
        <Card className="ui-panel" role="region" aria-label={t("reviews.findings")}>
          <h2>{t("reviews.findings")}</h2>
          <Finding task={task} />
        </Card>
        <Card className="ui-panel" role="region" aria-label={t("reviews.gates")}>
          <h2>{t("reviews.gates")}</h2>
          <ul className="ui-gates">{gates.map(gate => <li key={gate.key} data-gate={gate.key} data-state={gate.state}>
            <span className="ui-dot" data-state={gate.state === "passed" ? "complete" : gate.state === "waiting" ? "pending" : "unknown"} aria-hidden="true" />
            <span>{t((`reviews.gate.${gate.key}`) as "reviews.gate.tests")}</span>
            <span className="ui-gate-state">{t((`reviews.gateState.${gate.state}`) as "reviews.gateState.passed")}</span>
          </li>)}</ul>
        </Card>
        <Card className="ui-panel" role="region" aria-label={t("web.pendingDecisions")}>
          <h2>{t("web.pendingDecisions")}</h2>
          {!read ? <p className="team-muted">{t("value.unavailable")}</p>
            : !decision ? <p className="team-muted">{t("web.noDecisions")}</p>
            : <>
              <p className="team-muted"><code>{decision.action}</code> · <code>{decision.id}</code></p>
              <div className="ui-decision-actions">
                <Button variant="outline" disabled={!available || busy} onClick={event => { setTrigger(event.currentTarget); setChoice("rejected"); }}>
                  {t("reviews.requestChanges")}
                </Button>
                <Button variant="outline" className="ui-primary" disabled={!available || busy} onClick={event => { setTrigger(event.currentTarget); setChoice("approved"); }}>
                  {t("reviews.approve")}
                </Button>
              </div>
            </>}
        </Card>
      </aside>
    </div>
    {choice && decision && <OwnerDialog title={t(choice === "approved" ? "reviews.approve" : "reviews.requestChanges")}
      description={t("reviews.confirmDecision")} trigger={trigger} onClose={() => { setChoice(null); setMessage(null); }}>
      <dl className="ui-facts">
        <div><dt>{t("web.action")}</dt><dd><code>{decision.action}</code></dd></div>
        <div><dt>{t("web.taskId")}</dt><dd><code>{task?.taskId ?? "—"}</code></dd></div>
        <div><dt>{t("web.target")}</dt><dd><code>{decision.targetDigest}</code></dd></div>
      </dl>
      {message && <p role={["team.conflict", "web.unacknowledged", "team.denied"].includes(message) ? "alert" : "status"}>{t(message as "team.observed")}</p>}
      <Button variant="outline" disabled={!available || busy || message !== null} onClick={() => void submit(choice)}>{t("web.confirmDecision")}</Button>
    </OwnerDialog>}
  </div>;
}
