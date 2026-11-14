import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { OwnerReadError, useOwnerSession } from "../hooks/useOwnerSession.js";
import {
  INTAKE_MODES, INTAKE_RULE_LIMITS, intakeKey, saveIntakePolicy, useIntake, type IntakeDraft, type IntakeRule,
} from "./intake.js";

const emptyRule: IntakeRule = { name: "", instruction: "", enabled: true };

/** U13 — accept mode and rules; one Save sends the whole policy. */
export function IntakeSettings({ teamId }: { teamId: string }) {
  const { t } = useTranslation(), { paired, request } = useOwnerSession(), cache = useQueryClient();
  const intake = useIntake(teamId);
  const [draft, setDraft] = useState<IntakeDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ code: string | null; error: string | null } | null>(null);
  const saved = intake.data?.policy;
  if (!saved) return <section className="plate ui-settings-panel" aria-label={t("intake.title")}>
    <h2>{t("intake.title")}</h2><p role={intake.isError ? "alert" : "status"}>{t(intake.isError ? "settings.saveFailed" : "web.loading")}</p>
    {intake.isError && <button className="btn btn-outline" onClick={() => void intake.refetch()}>{t("action.retry")}</button>}
  </section>;
  const form: IntakeDraft = draft ?? { mode: saved.mode, rules: saved.rules };
  const update = (value: Partial<IntakeDraft>) => setDraft({ ...form, ...value });
  const changeRule = (index: number, value: Partial<IntakeRule>) => update({
    rules: form.rules.map((rule, position) => position === index ? { ...rule, ...value } : rule),
  });
  const duplicate = form.rules.some((rule, index) => form.rules.findIndex(other => other.name === rule.name) !== index);
  const complete = form.rules.every(rule => rule.name.trim() && rule.instruction.trim());
  const save = async () => {
    if (busy || !draft) return;
    setBusy(true); setFailure(null);
    try {
      const policy = await saveIntakePolicy(request, teamId, saved.revision, form);
      await cache.cancelQueries({ queryKey: intakeKey(teamId) });
      cache.setQueryData(intakeKey(teamId), { ...intake.data, policy });
      setDraft(null);
    } catch (error) {
      setFailure(error instanceof OwnerReadError ? { code: error.code, error: error.error } : { code: null, error: null });
    } finally { setBusy(false); }
  };
  return <section className="plate ui-settings-panel" aria-label={t("intake.title")}>
    <h2>{t("intake.title")}</h2>
    <fieldset className="ui-intake-modes" aria-label={t("intake.mode")}>
      <legend>{t("intake.mode")}</legend>
      {INTAKE_MODES.map(mode => <label className="ui-motion-toggle" key={mode}>
        <input type="radio" name="intake-mode" checked={form.mode === mode} disabled={busy || !paired}
          onChange={() => update({ mode })} />{t(`intake.mode.${mode}`)}</label>)}
    </fieldset>
    <fieldset className="ui-model-allowlist" aria-label={t("intake.rules")}>
      <legend>{t("intake.rules")}</legend>
      {form.rules.map((rule, index) => <div className="ui-intake-rule" key={index}>
        <label className="field">{t("intake.ruleName", { index: index + 1 })}<input className="input" value={rule.name}
          maxLength={INTAKE_RULE_LIMITS.name} disabled={busy} onChange={event => changeRule(index, { name: event.target.value })} /></label>
        <label className="field">{t("intake.ruleInstruction", { index: index + 1 })}<textarea className="input" rows={3}
          maxLength={INTAKE_RULE_LIMITS.instruction} disabled={busy} value={rule.instruction}
          onChange={event => changeRule(index, { instruction: event.target.value })} /></label>
        <div className="ui-intake-rule-foot">
          <label className="ui-motion-toggle"><input type="checkbox" checked={rule.enabled} disabled={busy}
            onChange={event => changeRule(index, { enabled: event.target.checked })} />{t("intake.enabled")}</label>
          <button className="btn btn-outline" type="button" disabled={busy} aria-label={t("intake.removeRule", { index: index + 1 })}
            onClick={() => update({ rules: form.rules.filter((_, position) => position !== index) })}>{t("intake.removeShort")}</button>
        </div>
      </div>)}
      <button className="btn btn-outline" type="button" disabled={busy || form.rules.length >= INTAKE_RULE_LIMITS.rules}
        onClick={() => update({ rules: [...form.rules, emptyRule] })}>{t("intake.addRule")}</button>
    </fieldset>
    {(draft || busy || failure) && <div className="ui-save-bar">
      {failure && <p role="alert">{failure.code === "intake_policy_conflict" ? t("intake.conflict") : failure.error ?? t("settings.saveFailed")}</p>}
      {failure?.code === "intake_policy_conflict" && <button className="btn btn-outline" type="button"
        onClick={() => { setDraft(null); setFailure(null); void intake.refetch(); }}>{t("intake.reload")}</button>}
      <button className="btn btn-primary" type="button" disabled={busy || !draft || duplicate || !complete}
        onClick={() => void save()}>{t("intake.save")}</button>
      {draft && <button className="btn btn-outline" type="button" disabled={busy}
        onClick={() => { setDraft(null); setFailure(null); }}>{t("action.cancel")}</button>}
    </div>}
  </section>;
}