import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TeamModelChoice, TeamModelSettings } from "@openrig/daemon/team-control";
import { OwnerReadError, useOwnerSession } from "../hooks/useOwnerSession.js";
import { teamsKey } from "./hooks.js";

interface ModelSettingsReply { settings: TeamModelSettings; modelChoices?: TeamModelChoice[] }
interface ModelDraft { lead: TeamModelChoice; allowedSubagents: TeamModelChoice[]; kind: "project" | "test" }
const draftOf = (settings: TeamModelSettings): ModelDraft => ({ lead: { ...settings.lead, model: settings.lead.model ?? "" },
  allowedSubagents: settings.allowedSubagents ?? [], kind: settings.kind });

export function ModelSettings({ teamId }: { teamId: string }) {
  const { t } = useTranslation(), { paired, request } = useOwnerSession();
  const launchesId = useId(), choicesId = useId();
  const cache = useQueryClient(), key = ["team", "model-settings", teamId];
  const settings = useQuery({ queryKey: key, enabled: paired, retry: false, refetchInterval: 5_000,
    queryFn: ({ signal }) => request<ModelSettingsReply>(`/teams/${encodeURIComponent(teamId)}/settings`, { signal }) });
  const [draft, setDraft] = useState<ModelDraft | null>(null);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<string | null>(null);
  const saved = settings.data?.settings;
  if (!saved) return <section className="plate ui-settings-panel">
    <p role={settings.isError ? "alert" : "status"}>{t(settings.isError ? "settings.saveFailed" : "web.loading")}</p>
    {settings.isError && <button className="btn btn-outline" onClick={() => void settings.refetch()}>{t("action.retry")}</button>}
  </section>;
  const form = draft ?? draftOf(saved);
  const setLead = (update: Partial<TeamModelChoice>) => setDraft({ ...form, lead: { ...form.lead, ...update } });
  const setWorker = (index: number, update: Partial<TeamModelChoice>) => setDraft({ ...form,
    allowedSubagents: form.allowedSubagents.map((item, i) => i === index ? { ...item, ...update } : item) });
  const clients = <><option value="claude-code">Claude Code</option><option value="codex">Codex</option></>;
  const choices = (client: TeamModelChoice["client"]) => [...new Set([
    ...(settings.data?.modelChoices ?? []), ...(saved.lead.model ? [{ client: saved.lead.client, model: saved.lead.model }] : []),
    ...(saved.allowedSubagents ?? []),
  ].filter(choice => choice.client === client).map(choice => choice.model))].sort();
  return <section className="plate ui-settings-panel" aria-label={t("models.title")}>
    <h2>{t("models.title")}</h2>
    <form className="ui-model-form" onSubmit={async event => {
      event.preventDefault(); if (busy) return;
      setBusy(true); setFailure(null);
      try {
        const result = await request<{ settings: TeamModelSettings }>(`/teams/${encodeURIComponent(teamId)}/settings`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form),
        });
        await cache.cancelQueries({ queryKey: key });
        cache.setQueryData(key, { ...settings.data, ...result }); setDraft(null);
        void cache.invalidateQueries({ queryKey: teamsKey });
      } catch (error) { setFailure(error instanceof OwnerReadError ? error.code : "generic"); }
      finally { setBusy(false); }
    }}>
      <label className="field">{t("models.projectKind")}<select className="input" value={form.kind} disabled={busy}
        onChange={event => setDraft({ ...form, kind: event.target.value as ModelDraft["kind"] })}>
        <option value="project">{t("records.project")}</option><option value="test">{t("records.testProject")}</option>
      </select></label>
      <div className="ui-model-row">
        <label className="field">{t("models.leadClient")}<select className="input" value={form.lead.client} disabled={busy}
          onChange={event => setLead({ client: event.target.value as TeamModelChoice["client"], model: "" })}>{clients}</select></label>
        <label className="field">{t("models.leadModel")}<input className="input mono" value={form.lead.model} required maxLength={128}
          list={choicesId + "-" + form.lead.client} disabled={busy} onChange={event => setLead({ model: event.target.value })} /></label>
      </div>
      {(["claude-code", "codex"] as const).map(client => <datalist id={choicesId + "-" + client} key={client}>
        {choices(client).map(model => <option key={model} value={model} />)}
      </datalist>)}
      <fieldset className="ui-model-allowlist"><legend>{t("models.allowed")}</legend>
        {form.allowedSubagents.map((item, index) => <div className="ui-model-row" key={index}>
          <label className="field">{t("models.workerClient", { index: index + 1 })}<select className="input" value={item.client} disabled={busy}
            onChange={event => setWorker(index, { client: event.target.value as TeamModelChoice["client"], model: "" })}>{clients}</select></label>
          <label className="field">{t("models.workerModel", { index: index + 1 })}<input className="input mono" value={item.model} required maxLength={128}
            list={choicesId + "-" + item.client} disabled={busy} onChange={event => setWorker(index, { model: event.target.value })} /></label>
          <button className="btn btn-outline" type="button" disabled={busy} aria-label={t("models.remove", { index: index + 1 })}
            onClick={() => setDraft({ ...form, allowedSubagents: form.allowedSubagents.filter((_, i) => i !== index) })}>{t("models.removeShort")}</button>
        </div>)}
        <button className="btn btn-outline" type="button" disabled={busy || form.allowedSubagents.length >= 32}
          onClick={() => setDraft({ ...form, allowedSubagents: [...form.allowedSubagents, { client: form.lead.client, model: "" }] })}>{t("models.add")}</button>
        {form.allowedSubagents.length === 0 && <p className="muted">{t("models.empty")}</p>}
      </fieldset>
      <details className="muted"><summary>{t("models.modelHelp")}</summary><p>{t("models.modelHelpDetail")}</p></details>
      {failure && <p role="alert">{t(failure === "team_models_busy" ? "models.busy" : failure === "invalid_team_contract" ? "models.invalid" : "settings.saveFailed")}</p>}
      <button className="btn btn-primary" type="submit" disabled={busy || !draft || !form.lead.model.trim()}>{t("models.save")}</button>
    </form>
    <section className="ui-model-effective" aria-label={t("models.effective")}>
      <h3>{t("models.effective")}</h3><p role="status">{t(saved.configured ? "models.enforced" : "models.unconfigured")}</p>
      {saved.configured && <><p className="mono">{saved.lead.client} · {saved.lead.model}</p>
        <ul>{saved.allowedSubagents?.map(item => <li className="mono" key={item.client + item.model}>{item.client} · {item.model}</li>)}</ul></>}
      <h3 id={launchesId}>{t("models.launches")}</h3>
      {!saved.launches.length ? <p className="muted">{t("models.noLaunches")}</p> : <div className="ui-model-launches" role="region" aria-labelledby={launchesId} tabIndex={0}><table aria-labelledby={launchesId}>
        <thead><tr><th scope="col">{t("models.requested")}</th><th scope="col">{t("models.observed")}</th><th scope="col">{t("models.launchState")}</th></tr></thead>
        <tbody>{saved.launches.map((launch, index) => <tr key={launch.attemptId + index}>
          <td>{launch.client} · {launch.requestedModel ?? t("models.nativeDefault")}</td>
          <td>{launch.observedModel ?? t("models.notObserved")}</td><td>{launch.state === "unregistered" ? t("web.unknown") : t(`status.attempt.${launch.state}`)}</td>
        </tr>)}</tbody></table></div>}
    </section>
  </section>;
}
