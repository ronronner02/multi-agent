import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { OwnerReadError, useOwnerSession } from "../hooks/useOwnerSession.js";

type SectionName = "communication" | "scope" | "delivery";
interface SectionView { name: SectionName; text: string; overridden: boolean; defaultText: string; previousDefault: string | null; defaultChanged: boolean }
interface SectionsReply { revision: number; sections: SectionView[] }

/** Plan R13/R14 — the team's three editable prompt sections, one save bar, and the default-updated choice. */
export function PromptSectionSettings({ teamId }: { teamId: string }) {
  const { t } = useTranslation(), { paired, request } = useOwnerSession(), cache = useQueryClient();
  const key = ["team", "prompt-sections", teamId];
  const settings = useQuery({ queryKey: key, enabled: paired, retry: false,
    queryFn: ({ signal }) => request<SectionsReply>(`/teams/${encodeURIComponent(teamId)}/prompt-sections`, { signal }) });
  const [drafts, setDrafts] = useState<Partial<Record<SectionName, string>>>({});
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<string | null>(null);
  const saved = settings.data;
  if (!saved) return <section className="plate ui-settings-panel" aria-label={t("sections.title")}>
    <h2>{t("sections.title")}</h2><p role={settings.isError ? "alert" : "status"}>{t(settings.isError ? "settings.saveFailed" : "web.loading")}</p>
    {settings.isError && <button className="btn btn-outline" onClick={() => void settings.refetch()}>{t("action.retry")}</button>}
  </section>;
  const changed = Object.keys(drafts).length > 0;
  const save = async (sections: Partial<Record<SectionName, string | null>>) => {
    if (busy) return;
    setBusy(true); setFailure(null);
    try {
      const result = await request<SectionsReply>(`/teams/${encodeURIComponent(teamId)}/prompt-sections`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseRevision: saved.revision, sections }),
      });
      cache.setQueryData(key, result); setDrafts({});
    } catch (error) { setFailure(error instanceof OwnerReadError ? error.code : "generic"); }
    finally { setBusy(false); }
  };
  return <section className="plate ui-settings-panel" aria-label={t("sections.title")}>
    <h2>{t("sections.title")}</h2>
    {saved.sections.map(section => <div className="ui-prompt-section" key={section.name}>
      <label className="field">{t(`sections.${section.name}`)}
        <textarea className="input mono ui-soul-content" rows={7} value={drafts[section.name] ?? section.text} disabled={busy}
          onChange={event => setDrafts({ ...drafts, [section.name]: event.target.value })} /></label>
      {section.defaultChanged && <div className="ui-default-changed" role="group" aria-label={t("sections.defaultChanged")}>
        <p className="chip">{t("sections.defaultChanged")}</p>
        <div className="ui-default-compare">
          <div><h3>{t("sections.previousDefault")}</h3><pre>{section.previousDefault}</pre></div>
          <div><h3>{t("sections.newDefault")}</h3><pre>{section.defaultText}</pre></div>
        </div>
        <div><button className="btn btn-outline" type="button" disabled={busy} onClick={() => void save({ [section.name]: section.text })}>{t("sections.keepMine")}</button>
          <button className="btn btn-outline" type="button" disabled={busy} onClick={() => void save({ [section.name]: null })}>{t("sections.useNew")}</button></div>
      </div>}
      {section.overridden && !section.defaultChanged && <button className="btn btn-outline" type="button" disabled={busy}
        onClick={() => void save({ [section.name]: null })}>{t("sections.useDefault")}</button>}
    </div>)}
    {(changed || busy || failure) && <div className="ui-save-bar">
      {failure && <p role="alert">{t(failure === "sections_revision_conflict" ? "sections.conflict" : failure === "sections_too_large" ? "sections.tooLarge" : "settings.saveFailed")}</p>}
      {failure === "sections_revision_conflict" && <button className="btn btn-outline" type="button" onClick={() => { setDrafts({}); setFailure(null); void settings.refetch(); }}>{t("action.retry")}</button>}
      <button className="btn btn-primary" type="button" disabled={busy || !changed} onClick={() => void save(drafts)}>{t("sections.save")}</button>
      {changed && <button className="btn btn-outline" type="button" disabled={busy} onClick={() => { setDrafts({}); setFailure(null); }}>{t("action.cancel")}</button>}
    </div>}
  </section>;
}
