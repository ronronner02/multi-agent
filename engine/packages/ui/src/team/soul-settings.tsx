import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { SpecialistSoul, TeamRole } from "@multi-agent/daemon/team-control";
import { OwnerReadError, useOwnerSession } from "../hooks/useOwnerSession.js";

interface SoulSettingsReply {
  profiles: SpecialistSoul[];
  seats: Array<{ nodeId: string; role: TeamRole; soulId: string; member: string | null }>;
}
type SoulDraft = Pick<SpecialistSoul, "id" | "name" | "roles" | "content" | "version">;
const roles: TeamRole[] = ["lead", "implementer", "reviewer"];
const builtinNames: Record<string, string> = {
  coordinator: "Project coordinator", engineer: "Software engineer", architect: "Systems architect",
  frontend: "Frontend specialist", backend: "Backend specialist", verification: "Verification specialist", reviewer: "Independent reviewer",
};

export function SoulSettings({ teamId }: { teamId: string }) {
  const { t } = useTranslation(), { paired, request } = useOwnerSession(), cache = useQueryClient();
  const key = ["team", "souls", teamId];
  const settings = useQuery({ queryKey: key, enabled: paired, retry: false,
    queryFn: async ({ signal }) => {
      const result = await request<SoulSettingsReply>(`/teams/${encodeURIComponent(teamId)}/souls`, { signal });
      if (!Array.isArray(result?.profiles) || !result.profiles.length || !Array.isArray(result.seats)) throw new Error("Invalid specialist profile response");
      return result;
    } });
  const [selected, setSelected] = useState(""), [draft, setDraft] = useState<SoulDraft | null>(null);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<string | null>(null);
  const saved = settings.data;
  if (!saved) return <section className="plate ui-settings-panel" aria-label={t("souls.title")}>
    <h2>{t("souls.title")}</h2><p role={settings.isError ? "alert" : "status"}>{t(settings.isError ? "settings.saveFailed" : "web.loading")}</p>
    {settings.isError && <button className="btn btn-outline" onClick={() => void settings.refetch()}>{t("action.retry")}</button>}
  </section>;
  const profile = saved.profiles.find(item => item.id === selected) ?? saved.profiles[0]!;
  const form = draft ?? profile;
  const profileName = (item: SpecialistSoul) => item.version === 1 && builtinNames[item.id] === item.name
    ? t(`souls.builtin.${item.id}` as "souls.builtin.engineer") : item.name;
  const update = (value: Partial<SoulDraft>) => setDraft({ ...form, ...value });
  const reportError = (error: unknown) => setFailure(error instanceof OwnerReadError ? error.code : "generic");
  return <section className="plate ui-settings-panel" aria-label={t("souls.title")}>
    <h2>{t("souls.title")}</h2>
    <details className="muted"><summary>{t("souls.about")}</summary><p>{t("souls.boundary")}</p></details>
    <label className="field">{t("souls.profile")}<select className="input" value={draft?.version === 0 ? "" : profile.id} disabled={busy}
      onChange={event => { setSelected(event.target.value); setDraft(null); setFailure(null); }}>
      {draft?.version === 0 && <option value="">{t("souls.new")}</option>}
      {saved.profiles.map(item => <option key={item.id} value={item.id}>{profileName(item)} · v{item.version}</option>)}
    </select></label>
    <button className="btn btn-outline" type="button" disabled={busy} onClick={() => {
      setDraft({ id: "", name: "", content: "", roles: ["implementer"], version: 0 }); setFailure(null);
    }}>{t("souls.add")}</button>
    <form className="ui-model-form" onSubmit={async event => {
      event.preventDefault(); if (!draft || busy) return;
      setBusy(true); setFailure(null);
      try {
        const result = await request<{ profile: SpecialistSoul }>(`/teams/${encodeURIComponent(teamId)}/souls/${encodeURIComponent(form.id)}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedVersion: form.version, name: form.name, roles: form.roles, content: form.content }),
        });
        cache.setQueryData(key, { ...saved, profiles: [...saved.profiles.filter(item => item.id !== result.profile.id), result.profile] });
        setSelected(result.profile.id); setDraft(null);
      } catch (error) { reportError(error); } finally { setBusy(false); }
    }}>
      {form.version === 0 && <label className="field">{t("souls.id")}<input className="input mono" required pattern="[a-z][a-z0-9-]*"
        maxLength={64} value={form.id} disabled={busy} onChange={event => update({ id: event.target.value })} /></label>}
      <label className="field">{t("souls.name")}<input className="input" required maxLength={128} value={form.name} disabled={busy}
        onChange={event => update({ name: event.target.value })} /></label>
      <fieldset className="ui-model-allowlist"><legend>{t("souls.roles")}</legend>{roles.map(role =>
        <label className="ui-motion-toggle" key={role}><input type="checkbox" checked={form.roles.includes(role)} disabled={busy}
          onChange={event => update({ roles: event.target.checked ? [...form.roles, role] : form.roles.filter(item => item !== role) })} />{t(`role.${role}`)}</label>)}</fieldset>
      <label className="field">{t("souls.content")}<textarea className="input mono ui-soul-content" rows={8} maxLength={16_384}
        required value={form.content} disabled={busy} onChange={event => update({ content: event.target.value })} /></label>
      <div><button className="btn btn-primary" type="submit" disabled={busy || !draft || !form.roles.length || !form.id || !form.name.trim() || !form.content.trim()}>{t("souls.save")}</button>
        {draft && <button className="btn btn-outline" type="button" disabled={busy} onClick={() => { setDraft(null); setFailure(null); }}>{t("action.cancel")}</button>}</div>
    </form>
    {failure && <p role="alert">{t(failure === "soul_version_conflict" ? "souls.conflict" : failure === "soul_seat_busy" ? "souls.busy"
      : failure === "soul_in_use" || failure === "soul_role_mismatch" ? "souls.roleMismatch" : "settings.saveFailed")}</p>}
    {failure === "soul_version_conflict" && <button className="btn btn-outline" onClick={() => { setDraft(null); setFailure(null); void settings.refetch(); }}>{t("action.retry")}</button>}
    <h3>{t("souls.assignments")}</h3>
    {saved.seats.map((seat, index) => <label className="field" key={seat.nodeId}>{t("souls.seat", { index: index + 1 })} · {t(`role.${seat.role}`)}
      <select className="input" value={seat.soulId} disabled={busy} onChange={async event => {
        setBusy(true); setFailure(null);
        try {
          const updated = await request<SoulSettingsReply>(`/teams/${encodeURIComponent(teamId)}/seats/${encodeURIComponent(seat.nodeId)}/soul`, {
            method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ soulId: event.target.value }),
          });
          cache.setQueryData(key, updated);
        } catch (error) { reportError(error); } finally { setBusy(false); }
      }}>{saved.profiles.filter(item => item.roles.includes(seat.role)).map(item => <option key={item.id} value={item.id}>{profileName(item)}</option>)}</select>
    </label>)}
  </section>;
}
