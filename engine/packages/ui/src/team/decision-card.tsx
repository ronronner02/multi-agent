import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ControlReceipt, ControlRequest, TeamApproval, TeamAttemptView, TeamOwnerRead, TeamRun } from "@openrig/daemon/team-control";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { OwnerReadError, useOwnerSession } from "../hooks/useOwnerSession.js";
import { DecisionDialog, type DecisionMessage } from "./decision-dialog.js";

type Decision = {
  approval: TeamApproval; run: TeamRun; decision: "approved" | "rejected"; request: ControlRequest;
  message: DecisionMessage; reason: string | null; trigger: HTMLElement | null; submitted: boolean;
};

export function DecisionCard({ read, available, now, refresh, onOpenSession }: {
  read?: TeamOwnerRead; available: boolean; now: number; refresh: () => Promise<unknown>;
  onOpenSession?: (attempt: TeamAttemptView) => void;
}) {
  const { t } = useTranslation();
  const { request, paired } = useOwnerSession();
  const [selected, setSelected] = useState<Decision | null>(null);
  const [, redraw] = useState(0);
  const records = useRef(new Map<string, Decision>());
  const inFlight = useRef(new Set<string>());
  useEffect(() => {
    if (!available || !paired || !read) return;
    let changed = false;
    for (const entry of records.current.values()) {
      const outcome = read.approvals.find(item => item.id === entry.approval.id
        && item.runId === entry.run.id && item.bindingDigest === entry.approval.bindingDigest
        && item.targetDigest === entry.approval.targetDigest && item.payloadDigest === entry.approval.payloadDigest
        && ["approved", "rejected"].includes(item.state));
      if (!outcome) continue;
      const message = entry.submitted && outcome.state === entry.decision ? "team.observed" : "web.otherDecision";
      const reason = message === "web.otherDecision" ? t(`status.approval.${outcome.state}`) : null;
      if (entry.message !== message || entry.reason !== reason) { entry.message = message; entry.reason = reason; changed = true; }
    }
    if (changed) redraw(n => n + 1);
  }, [available, paired, read, t]);
  const pending = read?.approvals.filter(item => item.state === "pending");
  const enabled = (item: TeamApproval) => available && paired && !!read && item.runId === read.run.id
    && item.bindingDigest === read.run.bindingDigest && !["invalidated", "cancel_requested"].includes(read.run.state)
    && item.state === "pending" && Date.parse(item.expiresAt) > now;
  const current = (entry: Decision) => enabled(entry.approval) && !!read && (read.run.entityVersion === entry.run.entityVersion || entry.message === "web.unacknowledged")
    && read.run.binding.planDigest === entry.run.binding.planDigest && read.approvals.some(item => item.id === entry.approval.id
      && item.state === "pending" && item.entityVersion === entry.approval.entityVersion
      && item.targetDigest === entry.approval.targetDigest && item.payloadDigest === entry.approval.payloadDigest);
  const open = (approval: TeamApproval, decision: Decision["decision"], trigger: HTMLElement) => {
    const previous = records.current.get(approval.id);
    const entry: Decision = previous && (["web.unacknowledged", "team.requested", "team.observed", "web.otherDecision"].includes(previous.message) || inFlight.current.has(previous.request.idempotencyKey)) && previous.approval.entityVersion === approval.entityVersion ? previous : {
      approval, run: read!.run, decision, trigger, message: "", reason: null, submitted: false,
      request: { protocolVersion: "1.0", runId: approval.runId, actionId: approval.id, expectedEntityVersion: read!.run.entityVersion,
        idempotencyKey: crypto.randomUUID(), payload: { approvalVersion: approval.entityVersion, decision,
          ...(approval.action === "scope-extension" ? { expectedChainHead: approval.payload.expectedChainHead } : {}) } },
    };
    entry.trigger = trigger; records.current.set(approval.id, entry); setSelected(entry);
  };
  const submit = async () => {
    const entry = selected;
    if (!entry || !current(entry) || inFlight.current.has(entry.request.idempotencyKey)
      || entry.message && entry.message !== "web.unacknowledged") return;
    const update = (message: DecisionMessage, reason: string | null = null) => {
      if (entry.message !== "team.observed" && entry.message !== "web.otherDecision") { entry.message = message; entry.reason = reason; }
      redraw(n => n + 1);
    };
    entry.submitted = true; inFlight.current.add(entry.request.idempotencyKey); redraw(n => n + 1);
    try {
      const receipt = await request<ControlReceipt>(`/runs/${encodeURIComponent(entry.run.id)}/approvals/decide`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry.request), signal: AbortSignal.timeout(10_000),
      });
      if (receipt.status === "conflict") throw new OwnerReadError(409, receipt.reason ?? "control_conflict");
      update(receipt.status === "observed" ? "team.observed" : receipt.status === "denied" ? "team.denied" : "team.requested", receipt.reason);
      try { await refresh(); } catch { update(entry.message, t("team.refreshUnavailable")); }
    } catch (error) {
      if (error instanceof OwnerReadError) {
        update(error.status === 409 ? "team.conflict" : "team.denied", error.code);
        if (error.status === 409) {
          try { await refresh(); } catch { update("team.refreshUnavailable", error.code); }
        }
      } else update("web.unacknowledged");
    } finally { inFlight.current.delete(entry.request.idempotencyKey); redraw(n => n + 1); }
  };
  return <Card className="team-card team-decisions" role="region" tabIndex={-1} aria-label={t("web.pendingDecisions")}>
    <h2>{t("web.pendingDecisions")} <span>{available ? pending?.length ?? "?" : "?"}</span></h2>
    {pending === undefined ? <p>{t("web.unknown")}</p> : !pending.length ? available && <p>{t("web.noDecisions")}</p> : <ul>{pending.map(item => {
      const record = records.current.get(item.id);
      const message = record?.approval.entityVersion === item.entityVersion ? record.message : "";
      const locked = record && (inFlight.current.has(record.request.idempotencyKey) || ["web.unacknowledged", "team.requested", "team.observed", "web.otherDecision"].includes(message));
      const targets = read!.attempts.filter(attempt => attempt.runId === item.runId && attempt.state === "running" && attempt.session
        && (typeof item.payload.attemptId === "string" ? attempt.attemptId === item.payload.attemptId
          : typeof item.payload.session === "string" && attempt.session === item.payload.session));
      return <li key={item.id}><strong>{item.action}</strong><code>{item.id}</code>
        <dl className="team-facts"><div><dt>{t("web.target")}</dt><dd><code>{item.targetDigest}</code></dd></div>
          <div><dt>{t("web.binding")}</dt><dd><code>{item.bindingDigest}</code></dd></div>
          <div><dt>{t("web.version")}</dt><dd>{item.entityVersion}</dd></div></dl>
        {item.kind === "native" ? <><Button variant="outline" disabled={!available || targets.length !== 1 || !onOpenSession}
          onClick={() => onOpenSession?.(targets[0]!)}>{t("web.openSession")}</Button><p>{t(targets.length === 1 ? "team.nativeFault" : "web.nativeTarget")}</p></> : <>
          {(["approved", "rejected"] as const).map(decision => <Button key={decision} variant="outline" disabled={!enabled(item) || !!locked && record.decision !== decision}
            onClick={event => open(item, decision, event.currentTarget)}>{t(decision === "approved" ? "action.approve" : "action.reject")}</Button>)}
          {message && <p role="status">{t(message)}</p>}
          {message === "web.unacknowledged" && <Button variant="outline" disabled={!record || !current(record)}
            onClick={event => open(item, record!.decision, event.currentTarget)}>{t("action.retry")}</Button>}
        </>}
      </li>;
    })}</ul>}
    {!available && <p>{t("team.disabled")}</p>}
    {selected && <DecisionDialog {...selected} available={current(selected)} busy={inFlight.current.has(selected.request.idempotencyKey)}
      onClose={() => setSelected(null)} onConfirm={() => void submit()} />}
  </Card>;
}
