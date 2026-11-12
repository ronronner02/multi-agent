import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { FrameworkEntry, FrameworkOutcome, TaskWorkflow, WorkflowSelection } from "@multi-agent/daemon/team-control";
import { useOwnerSession } from "../hooks/useOwnerSession.js";

export function WorkflowPicker({ value, onChange, disabled }: {
  value: WorkflowSelection | undefined; onChange: (selection: WorkflowSelection | undefined) => void; disabled?: boolean;
}) {
  const { t } = useTranslation(), { paired, request } = useOwnerSession();
  const catalog = useQuery({ queryKey: ["team", "workflow-catalog"], enabled: paired, retry: false,
    queryFn: async ({ signal }) => {
      const result = await request<{ workflows: FrameworkEntry[] }>("/workflows", { signal });
      if (!Array.isArray(result?.workflows)) throw new Error("Invalid workflow catalog response");
      return result;
    } });
  const selected = catalog.data?.workflows.find(entry => entry.name === value?.entrypoint);
  return <div className="ui-workflow-picker">
    <label className="field">{t("workflows.select")}<select className="input" value={value?.entrypoint ?? ""} disabled={disabled || !catalog.data}
      onChange={event => onChange(event.target.value ? { entrypoint: event.target.value as WorkflowSelection["entrypoint"], readOnly: event.target.value === "spec-code-review" } : undefined)}>
      <option value="">{t("workflows.automatic")}</option>
      {catalog.data?.workflows.map(entry => <option key={entry.name} value={entry.name} disabled={entry.invocation === "caller"}>
        {entry.name}{entry.invocation === "caller" ? ` · ${t("workflows.callerOnly")}` : ""}</option>)}
    </select></label>
    {value && <label className="ui-motion-toggle"><input type="checkbox" checked={value.readOnly} disabled={disabled || selected?.name === "spec-code-review"}
      onChange={event => onChange({ ...value, readOnly: event.target.checked })} />{t("workflows.readOnly")}</label>}
    {selected?.prerequisite && <details className="muted"><summary>{t("workflows.prerequisite")}</summary><p>{selected.prerequisite}</p></details>}
    {catalog.isError && <button type="button" className="btn btn-outline" onClick={() => void catalog.refetch()}>{t("workflows.retryCatalog")}</button>}
  </div>;
}

export function WorkflowOutcomes({ runId }: { runId: string }) {
  const { t } = useTranslation(), { paired, request } = useOwnerSession();
  const history = useQuery({ queryKey: ["team", "workflow-outcomes", runId], enabled: paired && !!runId, retry: false, refetchInterval: 5_000,
    queryFn: ({ signal }) => request<{ workflows: Array<{ taskId: string; attemptId: string | null; generation: number | null; workflow: TaskWorkflow; outcome: FrameworkOutcome | null }> }>(
      `/runs/${encodeURIComponent(runId)}/workflows`, { signal }) });
  if (!history.data?.workflows.length) return history.isError ? <p role="status" className="muted">{t("workflows.unavailable")}</p> : null;
  return <details className="ui-workflow-outcomes"><summary>{t("workflows.outcomes")}</summary>
    <p className="muted">{t("workflows.evidenceBoundary")}</p>
    <ul>{history.data.workflows.map((row, index) => <li key={row.attemptId ? row.attemptId + ":" + row.generation : row.taskId + ":" + index}>
      <strong>{row.workflow.entrypoint}</strong> · {row.outcome?.status ?? t("workflows.pending")}
      {row.outcome?.reason && <p>{row.outcome.reason}</p>}{row.outcome?.summary && <p>{row.outcome.summary}</p>}
      {!!row.outcome?.artifacts.length && <ul>{row.outcome.artifacts.map(path => <li key={path}><code>{path}</code></li>)}</ul>}
    </li>)}</ul>
  </details>;
}
