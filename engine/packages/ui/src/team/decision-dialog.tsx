import { useRef, useState, type ReactNode } from "react";
import { Content } from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import type { JsonValue, TeamApproval, TeamRun } from "@openrig/daemon/team-control";
import { Dialog, DialogClose, DialogDescription, DialogOverlay, DialogPortal, DialogTitle } from "../components/ui/dialog.js";
import { Button } from "../components/ui/button.js";

export function OwnerDialog({ title, description, trigger, onClose, children }: {
  title: string; description: string; trigger: HTMLElement | null; onClose: () => void; children: ReactNode;
}) {
  const { t } = useTranslation();
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const fallback = container?.closest<HTMLElement>("[role=region], section[aria-label]");
  return <div ref={setContainer}><Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    {container && <DialogPortal container={container}><DialogOverlay />
      <Content ref={content} className="team-card team-decision-dialog" onOpenAutoFocus={event => { event.preventDefault(); content.current?.focus(); }} onCloseAutoFocus={event => { event.preventDefault(); (trigger?.isConnected && !trigger.matches(":disabled") ? trigger : fallback)?.focus(); }}>
        <DialogTitle>{title}</DialogTitle><DialogDescription className="team-muted">{description}</DialogDescription>
        {children}<DialogClose asChild><Button variant="outline">{t("web.close")}</Button></DialogClose>
      </Content>
    </DialogPortal>}
  </Dialog></div>;
}

export type DecisionMessage = "" | "team.requested" | "team.observed" | "web.otherDecision" | "team.denied" | "team.conflict" | "team.refreshUnavailable" | "web.unacknowledged";

export function DecisionDialog({ approval, run, decision, trigger, available, busy, message, reason, onConfirm, onClose }: {
  approval: TeamApproval; run: TeamRun; decision: "approved" | "rejected"; trigger: HTMLElement | null;
  available: boolean; busy: boolean; message: DecisionMessage; reason: string | null; onConfirm: () => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const value = (item: JsonValue | undefined) => item == null ? t("value.unavailable") : typeof item === "string" ? item : JSON.stringify(item);
  const fields = [
    ["web.requester", approval.payload.requester], ["web.action", approval.action], ["web.run", run.id],
    ["web.taskId", approval.payload.taskId], ["web.target", approval.targetDigest], ["web.digest", run.binding.planDigest],
    ["web.binding", approval.bindingDigest], ["web.version", approval.entityVersion], ["web.runVersion", run.entityVersion],
    ["team.expires", approval.expiresAt], ["web.files", approval.payload.paths], ["team.reason", approval.payload.reason],
    ["team.classification", approval.payload.classification], ["team.packages", approval.payload.packages],
  ] as const;
  return <OwnerDialog title={t("team.confirm")} description={t(decision === "approved" ? "action.approve" : "action.reject")} trigger={trigger} onClose={onClose}>
    <dl className="team-detail-facts">{fields.map(([label, item]) => <div key={label}><dt>{t(label)}</dt><dd><code>{value(item)}</code></dd></div>)}</dl>
    {approval.action === "scope-change" && approval.payload.change === "run-growth" && <>
      <h3>{t("web.binding")}</h3><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(approval.payload.binding, null, 2)}</pre>
      <h3>{t("edit.addTask")}</h3><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(approval.payload.tasks, null, 2)}</pre>
    </>}
    {message && <p role={["team.requested", "team.observed", "web.otherDecision"].includes(message) ? "status" : "alert"}>{t(message)}</p>}
    {reason && <p role="alert">{reason}</p>}
    {!available && !["team.observed", "web.otherDecision"].includes(message) && <p role="alert">{t("web.confirmAgain")}</p>}
    <Button variant="outline" disabled={!available || busy || !!message && message !== "web.unacknowledged"} onClick={onConfirm}>
      {t(message === "web.unacknowledged" ? "action.retry" : "web.confirmDecision")}
    </Button>
  </OwnerDialog>;
}
