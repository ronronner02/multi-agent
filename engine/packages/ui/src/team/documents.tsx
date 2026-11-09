import { useState } from "react";
import { TextPreview } from "./text-preview.js";
import { useTranslation } from "react-i18next";
import type { ProjectDocumentKind, ProjectDocumentStage, ProjectDocumentWorkflow, TeamOwnerRead } from "@openrig/daemon/team-control";
import { useOwnerSession } from "../hooks/useOwnerSession.js";
import { confirmDocument, selectDocumentStage, type ChatState } from "./clients.js";

const kinds = ["brainstorm", "requirements", "plan"] as const;
const stages = ["exploration", "requirements", "plan"] as const;
const current = (state: ProjectDocumentWorkflow, kind: ProjectDocumentKind) => state.versions.find(version => version.kind === kind);
export function documentDiscussionPending(read: TeamOwnerRead | undefined, chat: ChatState | undefined): boolean {
  const last = chat?.messages.at(-1);
  return !!chat?.pendingDecision || !!chat?.messages.some(message => message.kind === "decision" && !message.answeredBy)
    || !!read?.attempts.some(attempt => attempt.role === "lead" && attempt.state !== "stopped")
    || last?.sender === "owner" && last.kind !== "confirmation";
}

export function DocumentStages({ read, chat, onChanged }: { read?: TeamOwnerRead; chat?: ChatState; onChanged?: () => void }) {
  const { t, i18n } = useTranslation();
  const responseLanguage = i18n.resolvedLanguage === "zh-CN" ? "zh-CN" : "en";
  const { request } = useOwnerSession();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const state = chat?.documentWorkflow;
  if (!state || !read) return null;
  const requirements = current(state, "requirements");
  const confirmedRequirements = requirements && requirements.id === state.confirmed.requirements;
  const planning = read.run.phase === "planning";
  const waiting = planning && documentDiscussionPending(read, chat);
  const closed = ["canceled", "cancel_requested", "invalidated"].includes(read.run.state);
  return <section className="ui-document-stages" aria-label={t("documents.stages")}>
    <div className="ui-document-stage-buttons">{stages.map(stage => <button key={stage} className="btn btn-outline"
      aria-current={planning && stage === state.stage ? "step" : undefined}
      disabled={busy || closed || waiting || (stage === "plan" && (!confirmedRequirements || !!state.error))}
      onClick={async () => {
        setBusy(true); setError(null);
        try { await selectDocumentStage(request, read.run.id, read.run.entityVersion, stage, undefined, responseLanguage); onChanged?.(); }
        catch (cause) { setError(cause instanceof Error ? cause.message : t("web.error")); }
        finally { setBusy(false); }
      }}>{t(!planning ? `documents.revise.${stage}` : `documents.stage.${stage}`)}</button>)}</div>
    {!planning && <p className="muted">{t("documents.revisionConsequence")}</p>}
    {state.pendingStage && <p role="status">{t("documents.pendingRevision")}</p>}
    {waiting && <p className="muted" role="status">{t(chat?.pendingDecision ? "chat.answerQuestionFirst" : "documents.discussing")}</p>}
    {(error || state.error) && <p role="alert">{error || state.error}</p>}
  </section>;
}

export function DocumentsScreen({ read, chat, onDiscuss, onChanged, failed = false }: {
  read?: TeamOwnerRead; chat?: ChatState; failed?: boolean; onDiscuss: (opener: HTMLButtonElement, context: string) => void; onChanged?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const responseLanguage = i18n.resolvedLanguage === "zh-CN" ? "zh-CN" : "en";
  const { request } = useOwnerSession();
  const state = chat?.documentWorkflow;
  const [chosenKind, setKind] = useState<ProjectDocumentKind | null>(null);
  const [chosenVersion, setVersion] = useState<string | null>(null);
  const [comparison, setComparison] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const kind = chosenKind ?? (state?.stage === "exploration" ? "brainstorm" : state?.stage ?? "requirements");
  const versions = state?.versions.filter(version => version.kind === kind) ?? [];
  const selected = versions.find(version => version.id === chosenVersion) ?? versions[0];
  const compared = versions.find(version => version.id === comparison && version.id !== selected?.id);
  const isCurrent = !!selected && selected.id === versions[0]?.id;
  const isConfirmed = !!selected && state?.confirmed[kind] === selected.id;
  const requirements = state && current(state, "requirements");
  const lineageReady = kind !== "plan" || !!requirements && state?.confirmed.requirements === requirements.id
    && selected?.requirementsVersionId === requirements.id;
  const canConfirm = read?.run.phase === "planning" && read.run.state === "approved" && isCurrent && !isConfirmed
    && !documentDiscussionPending(read, chat) && !state?.pendingStage && !state?.error && lineageReady;
  return <div className="page ui-documents">
    <header className="ui-page-head"><div><h1 className="display">{t("nav.documents")}</h1>
      {read && <p className="ui-subtitle"><TextPreview text={read.run.displayName} /></p>}</div>
      <button className="btn btn-outline" disabled={busy} onClick={async event => {
        const opener = event.currentTarget;
        if (read && state && read.run.phase === "delivery") {
          setBusy(true); setError(null);
          try { await selectDocumentStage(request, read.run.id, read.run.entityVersion, kind === "brainstorm" ? "exploration" : kind, undefined, responseLanguage); onChanged?.(); }
          catch (cause) { setError(cause instanceof Error ? cause.message : t("web.error")); return; }
          finally { setBusy(false); }
        }
        onDiscuss(opener, selected ? [
          t("documents.discussContext", { kind: t(`documents.kind.${kind}`), version: selected.version, hash: selected.hash }),
          t("documents.latestContext", { version: versions[0]!.version, hash: versions[0]!.hash }),
          t(selected.content.length > 32_768 ? "documents.snapshotExcerpt" : "documents.snapshotContext"),
          selected.content.slice(0, 32_768),
        ].join("\n\n") : "");
      }}>{t("documents.discuss")}</button>
    </header>
    {failed || chat && !chat.available ? <section className="plate"><p role="alert">{t("documents.readFailed")}</p>
      <button className="btn btn-outline" onClick={onChanged}>{t("action.retry")}</button></section>
      : !chat ? <p role="status">{t("documents.loading")}</p> : !state ? <section className="plate"><p>{t("documents.legacy")}</p></section> : <>
      <section className="plate"><DocumentStages read={read} chat={chat} onChanged={onChanged} />
        {state.executionVersions && <p className="ui-document-binding">{t("documents.executionBinding")}: {kinds.flatMap(key => {
          const pin = state.executionVersions?.[key];
          const version = state.versions.find(item => item.id === pin?.versionId);
          return version ? [`${t(`documents.kind.${key}`)} v${version.version}`] : [];
        }).join(" · ")}</p>}
        {state.executionHistory.length > 0 && <details className="ui-document-evidence"><summary>{t("documents.executionHistory")}</summary>
          <ul>{state.executionHistory.map(entry => <li key={entry.bindingDigest}>{new Date(entry.createdAt).toLocaleString()} · {kinds.flatMap(key => {
            const version = state.versions.find(item => item.id === entry.versions[key]?.versionId);
            return version ? [`${t(`documents.kind.${key}`)} v${version.version}`] : [];
          }).join(" · ")}</li>)}</ul>
        </details>}
      </section>
      <div className="ui-document-layout">
        <aside className="plate ui-document-list" aria-label={t("documents.list")}>{kinds.map(key => {
          const latest = current(state, key);
          return <button key={key} className="ui-document-kind" aria-pressed={kind === key}
            onClick={() => { setKind(key); setVersion(null); setComparison(""); setError(null); }}>
            <strong>{t(`documents.kind.${key}`)}</strong><span className="muted">{latest
              ? `v${latest.version} · ${t(state.confirmed[key] === latest.id ? "documents.confirmed" : "documents.draft")}`
              : t(key === "brainstorm" ? "documents.optional" : "documents.notCreated")}</span>
          </button>;
        })}</aside>
        <section className="plate ui-document-reader" aria-label={t(`documents.kind.${kind}`)}>
          {!selected ? <p className="muted">{t(kind === "brainstorm" ? "documents.emptyBrainstorm" : "documents.emptyRequired")}</p> : <>
            <div className="ui-document-toolbar">
              <label>{t("documents.version")}<select className="input" value={selected.id} onChange={event => { setVersion(event.target.value); setError(null); }}>
                {versions.map(version => <option key={version.id} value={version.id}>v{version.version} · {new Date(version.createdAt).toLocaleString()}</option>)}
              </select></label>
              <label>{t("documents.compare")}<select className="input" value={compared?.id ?? ""} onChange={event => setComparison(event.target.value)}>
                <option value="">{t("documents.noComparison")}</option>
                {versions.filter(version => version.id !== selected.id).map(version => <option key={version.id} value={version.id}>v{version.version}</option>)}
              </select></label>
            </div>
            <div className="ui-document-status"><span className="chip">{t(isConfirmed ? "documents.confirmed" : isCurrent ? "documents.draft" : "documents.historical")}</span>
              {selected.confirmedAt && <span className="muted">{t("documents.confirmedAt", { time: new Date(selected.confirmedAt).toLocaleString() })}</span>}
              {selected.requirementsVersionId && <span className="muted">{t("documents.derivedFrom", {
                version: state.versions.find(version => version.id === selected.requirementsVersionId)?.version ?? "?" })}</span>}
            </div>
            <div className={compared ? "ui-document-comparison" : "ui-document-single"}>
              {compared && <article><h2>{t("documents.compareVersion", { version: compared.version })}</h2>
                <pre className="ui-document-content" tabIndex={0}>{compared.content}</pre></article>}
              <article><h2>{t("documents.readVersion", { version: selected.version })}</h2><pre className="ui-document-content" tabIndex={0}>{selected.content}</pre></article>
            </div>
            <details className="ui-document-evidence"><summary>{t("documents.evidence")}</summary>
              <p className="mono">{selected.path}</p><p className="mono">{selected.hash}</p><p className="mono">{selected.id}</p>
            </details>
            <div className="plate-foot"><button className="btn btn-primary" disabled={busy || !canConfirm} onClick={async () => {
              if (!read) return;
              setBusy(true); setError(null);
              try { await confirmDocument(request, read.run.id, read.run.entityVersion, selected, undefined, responseLanguage); onChanged?.(); }
              catch (cause) { setError(cause instanceof Error ? cause.message : t("web.error")); }
              finally { setBusy(false); }
            }}>{t("documents.confirmVersion", { version: selected.version })}</button></div>
            {kind === "plan" && !lineageReady && <p className="muted">{t("documents.stalePlan")}</p>}
            {error && <p role="alert">{error}</p>}
          </>}
        </section>
      </div>
    </>}
  </div>;
}
