import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { PlanGovernance } from "../../../../daemon/dist/domain/plan-governance.js";
import type { ControlRequest, ControlReceipt, JsonValue } from "@openrig/daemon/team-control";
import { OwnerReadError, useOwnerSession } from "../../hooks/useOwnerSession.js";
import { Button } from "../../components/ui/button.js";
import { OwnerDialog } from "../decision-dialog.js";

type Snapshot = ReturnType<PlanGovernance["taskForEdit"]>;
const labels = { priority: "web.priority", role: "web.role", order: "edit.order", notes: "edit.notes", dependencies: "web.dependencies",
  addTask: "edit.addTask", removeTask: "edit.removeTask", scope: "edit.scope", paths: "web.files", acceptanceCriteria: "web.criteria", limits: "edit.limits" } as const;
type Field = keyof typeof labels;
type EditResult = { classification: "applied" | "plan-change-required"; affectedTasks: string[] };
const initialValue = (field: Field, snapshot: Snapshot) => field === "paths" ? JSON.stringify(snapshot.task.paths) : field === "dependencies" ? snapshot.task.dependencies.join(", ")
  : field in snapshot.task ? String(snapshot.task[field as keyof Snapshot["task"]]) : "[]";

export function TaskEditControls({ runId, taskId }: { runId: string; taskId: string }) {
  const { t } = useTranslation(), session = useOwnerSession();
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  const query = useQuery({ queryKey: ["team", runId, "edit", taskId], enabled: session.paired && !!runId,
    retry: false, queryFn: ({ signal }) => session.request<Snapshot>(`/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/edit`, { signal }) });
  return <section aria-label={t("edit.title")} tabIndex={-1} className="focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[var(--team-focus)]">
    <Button variant="outline" disabled={!session.paired || !query.data || query.isFetching || query.isError || query.data.runState !== "approved"}
      onClick={event => setTrigger(event.currentTarget)}>{t("edit.title")}</Button>
    {query.isError && <p role="alert">{t("web.error")}: {t("value.unavailable")}</p>}
    {query.data && <>
      <dl className="team-detail-facts"><div><dt>{t("web.priority")}</dt><dd>{t(`edit.${query.data.task.priority as "routine" | "urgent" | "critical"}`)}</dd></div>
        <div><dt>{t("edit.order")}</dt><dd>{query.data.task.order}</dd></div><div><dt>{t("edit.notes")}</dt><dd>{query.data.task.notes || t("value.unavailable")}</dd></div></dl>
      <h3>{t("edit.extensions")}</h3>
      {query.data.scope.extensions.length ? <ul>{query.data.scope.extensions.map(extension => <li key={extension.id}>
        <code>{extension.id}</code>: {extension.automatic && extension.state === "approved" ? t("edit.automatic") : t(`edit.${extension.state}`)}
        <ul>{extension.paths.map(path => <li key={path.path}><code>{path.path}</code> ({path.operation})</li>)}</ul>
      </li>)}</ul> : <p>{t("edit.noExtensions")}</p>}
    </>}
    {trigger && query.data && <TaskEditDialog snapshot={query.data} runId={runId} trigger={trigger}
      refreshing={query.isFetching} refresh={async () => { await query.refetch({ throwOnError: true }); }} onClose={() => setTrigger(null)} />}
  </section>;
}

export function TaskEditDialog({ snapshot, runId, trigger, refreshing, refresh, onClose }: {
  snapshot: Snapshot; runId: string; trigger: HTMLElement | null; refreshing: boolean; refresh: () => Promise<void>; onClose: () => void;
}) {
  const { t } = useTranslation(), session = useOwnerSession(), cache = useQueryClient();
  const [field, setField] = useState<Field>("notes"), [value, setValue] = useState(snapshot.task.notes);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<"" | "conflict" | "unknown" | "error" | "applied" | "plan-change-required">("");
  const [fresh, setFresh] = useState(true);
  const [affected, setAffected] = useState<string[]>([]);
  const pending = useRef<ControlRequest | null>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const locked = busy || message === "unknown" || message === "applied" || message === "plan-change-required";
  const confirm = async () => {
    if (busy || !session.paired || !pending.current && (refreshing || !fresh || snapshot.runState !== "approved")) return;
    let request = pending.current;
    if (!request) {
      let parsed: JsonValue;
      try {
        parsed = field === "notes" || field === "role" || field === "priority" ? value
          : field === "order" ? Number(value) : field === "dependencies" ? value.split(",").map(id => id.trim()).filter(Boolean) : JSON.parse(value);
        if (field === "order" && (!value.trim() || !Number.isInteger(parsed))) throw new Error();
      } catch { setMessage("error"); return; }
      request = { protocolVersion: "1.0", runId, actionId: snapshot.task.taskId, expectedEntityVersion: snapshot.runVersion,
        idempotencyKey: crypto.randomUUID(), payload: { expectedTaskVersion: snapshot.task.taskVersion, changes: { [field]: parsed } } };
      pending.current = request;
    }
    setBusy(true);
    try {
      const receipt = await session.request<ControlReceipt<EditResult>>(`/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(snapshot.task.taskId)}/edit`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
      });
      if (!alive.current) return;
      if (!receipt.value || !["applied", "plan-change-required"].includes(receipt.value.classification)) throw new Error("Missing edit receipt");
      pending.current = null; setMessage(receipt.value.classification); setAffected(receipt.value.affectedTasks);
      void cache.invalidateQueries({ queryKey: ["team", runId] });
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof OwnerReadError) {
        if (error.status >= 500) setMessage("unknown");
        else if (error.status === 409) {
          pending.current = null; setMessage("conflict"); setFresh(false);
          try { await refresh(); if (alive.current) setFresh(true); } catch { if (alive.current) setMessage("error"); }
        } else { pending.current = null; setMessage("error"); }
      } else setMessage("unknown");
    } finally { if (alive.current) setBusy(false); }
  };
  return <OwnerDialog title={t("edit.title")} description={t("edit.description")} trigger={trigger} onClose={onClose}>
    <p>{t("web.taskId")}: <code>{snapshot.task.taskId}</code> | {t("web.version")}: {snapshot.task.taskVersion} | {t("web.runVersion")}: {snapshot.runVersion}</p>
    <p>{t("edit.suspensionWarning")}</p>
    <div className="team-search"><label>{t("edit.field")}<select value={field} disabled={locked} onChange={event => {
      const next = event.target.value as Field; setField(next); setValue(initialValue(next, snapshot)); setMessage("");
    }}>{(Object.keys(labels) as Field[]).map(name => <option key={name} value={name}>{t(labels[name])}</option>)}</select></label>
      <label>{t("edit.value")}{field === "priority" || field === "role" ? <select value={value} disabled={locked} onChange={event => setValue(event.target.value)}>
        {(field === "priority" ? ["routine", "urgent", "critical"] : ["lead", "implementer", "reviewer"]).map(option =>
          <option key={option} value={option}>{field === "priority" ? t(`edit.${option as "routine" | "urgent" | "critical"}`) : t(`role.${option as "lead" | "implementer" | "reviewer"}`)}</option>)}
      </select> : <textarea className="focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[var(--team-focus)]" value={value} disabled={locked} rows={4} maxLength={16384} style={{ width: "100%", minHeight: 88, background: "var(--team-panel)", color: "var(--team-text)", border: "1px solid var(--team-control)", borderRadius: 5, padding: "8px 11px", font: "inherit" }}
        onChange={event => setValue(event.target.value)} />}</label>
    </div>
    <p>{t("edit.format")}</p>
    {message && <p role={message === "applied" ? "status" : "alert"} data-testid="task-edit-result">{t(`edit.${message}`)}</p>}
    {affected.length > 0 && <p>{t("edit.affected")}: <code>{affected.join(", ")}</code></p>}
    <Button variant="outline" disabled={busy || !session.paired || !pending.current && (refreshing || !fresh || snapshot.runState !== "approved") || message === "applied" || message === "plan-change-required"}
      onClick={() => { void confirm(); }}>{t(message === "unknown" ? "edit.retryExact" : "edit.submit")}</Button>
  </OwnerDialog>;
}
