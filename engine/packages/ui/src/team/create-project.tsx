import { useEffect, useRef, useState, type RefObject } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { MessageKey } from "@multi-agent/i18n";
import { OwnerReadError, useOwnerSession } from "../hooks/useOwnerSession.js";
import { FolderBrowser } from "./folder-browser.js";
import { latestRunFor, teamsKey, type TeamSummary, type RunSummary } from "./hooks.js";
import { clientLabel } from "./display.js";

interface Preview { repository: string; name: string; action: "create" | "push" | "register" | "open"; fileCount: number; excludedPaths: string[] }
const ERRORS: Record<string, MessageKey> = {
  github_repo_exists: "projects.nameTaken", github_push_failed: "projects.pushFailed",
  github_repo_create_failed: "projects.createFailed", github_not_signed_in: "github.title",
  team_folder_refused: "projects.folderRefused", team_exists: "projects.alreadyExists",
  team_origin_changed: "projects.folderChanged", team_bootstrap_changed: "projects.folderChanged",
  folder_pick_failed: "projects.pickFailed", team_file_too_large: "projects.fileTooLarge",
  github_view_retry: "projects.viewRetry", github_push_timeout: "projects.pushTimeout",
  github_large_file_rejected: "projects.largeFileRejected", github_network_failure: "projects.networkFailure",
  github_auth_failure: "projects.authFailure", github_proxy_unreachable: "projects.proxyUnreachable",
};

export function CreateProject({ open, mode = "create", onOpenChange, onCreated, opener }: {
  open: boolean; mode?: "create" | "open"; onOpenChange: (open: boolean) => void; onCreated: (team: TeamSummary) => void; opener: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const { request } = useOwnerSession();
  const cache = useQueryClient();
  const [repository, setRepository] = useState(""), [name, setName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false), [browsing, setBrowsing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [oversized, setOversized] = useState<string[]>([]);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (failure === "github_repo_exists" && !busy) nameInput.current?.focus(); }, [failure, busy]);
  const pickFolder = (window as Window & { multiAgentDesktop?: { pickFolder?: () => Promise<string | null> } }).multiAgentDesktop?.pickFolder;
  const changeFolder = (value: string) => { setRepository(value); setPreview(null); setFailure(null); setOversized([]); };
  const browse = async () => {
    if (busy) return;
    if (!pickFolder) { setBrowsing(true); return; }
    setBusy(true); setFailure(null);
    try { const value = await pickFolder(); if (value !== null) changeFolder(value); }
    catch { setFailure("folder_pick_failed"); } finally { setBusy(false); }
  };
  const submit = async () => {
    if (busy || !repository.trim() || (mode === "create" && !name.trim())) return;
    setBusy(true); setFailure(null);
    try {
      if (!preview) {
        const result = await request<{ preview: Preview }>("/teams", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repository: repository.trim(), ...(name.trim() ? { name: name.trim() } : {}), ...(mode === "open" ? { openExisting: true } : {}), dryRun: true }) });
        setPreview(result.preview);
      } else {
        const result = await request<{ team: TeamSummary }>("/teams", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repository: preview.repository, name: preview.name, ...(mode === "open" ? { openExisting: true } : {}) }) });
        await cache.invalidateQueries({ queryKey: teamsKey });
        setRepository(""); setName(""); setPreview(null); onOpenChange(false); onCreated(result.team);
      }
    } catch (error) {
      const code = error instanceof OwnerReadError ? error.code : "team_creation_failed";
      setFailure(code);
      // The refusal names the files that are too large, so the owner knows what to remove or ignore
      // without guessing from a failed upload later.
      setOversized(error instanceof OwnerReadError ? error.details.oversizedPaths ?? [] : []);
      if (code === "github_repo_exists") setPreview(null);
      if (code === "github_push_failed") setPreview(current => current ? { ...current, action: "push" } : null);
      if (code === "team_origin_changed" || code === "team_bootstrap_changed") setPreview(null);
    } finally { setBusy(false); }
  };
  return <Dialog.Root open={open} onOpenChange={next => { if (!busy) { setBrowsing(false); if (!next) setPreview(null); onOpenChange(next); } }}>
    <Dialog.Overlay className="ui-dialog-overlay" />
    <Dialog.Content className="ui-create-project" aria-describedby={undefined} onCloseAutoFocus={event => {
      event.preventDefault(); opener.current?.focus();
    }} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onInteractOutside={event => { if (busy) event.preventDefault(); }}>
      <header className="ui-panel-heading"><Dialog.Title>{t(mode === "open" ? "projects.open" : "projects.create")}</Dialog.Title>
        <Dialog.Close className="ui-icon-button" disabled={busy} aria-label={t("web.close")}><X aria-hidden="true" /></Dialog.Close></header>
      <div className="ui-create-body">{browsing ? <FolderBrowser onSelect={path => { changeFolder(path); setBrowsing(false); }} onCancel={() => setBrowsing(false)} />
        : <form onSubmit={event => { event.preventDefault(); void submit(); }}>
          <div className="field"><label htmlFor="project-folder">{t("projects.folder")}</label>
            <div className="ui-folder-input"><input id="project-folder" className="input mono" value={repository} disabled={busy}
              required maxLength={4096} onChange={event => changeFolder(event.target.value)} />
              <button className="btn btn-outline" type="button" disabled={busy} onClick={() => void browse()}>{t("team.create.browse")}</button></div>
          </div>
          {mode === "create" && <div className="field"><label htmlFor="project-name">{t("projects.name")}</label>
            <input ref={nameInput} id="project-name" className="input" value={name} disabled={busy} required maxLength={100}
              onChange={event => { setName(event.target.value); setPreview(null); setFailure(null); setOversized([]); }} /></div>}
          {preview && <section className="ui-create-preview" aria-label={t("projects.preview")}>
            {preview.action !== "open" && <strong>{t("projects.fileCount", { count: preview.fileCount })}</strong>}
            <code>{preview.repository}</code>
            {preview.excludedPaths.length > 0 && <div><h3>{t("projects.excluded")}</h3>
              <ul>{preview.excludedPaths.map(path => <li key={path}><code>{path}</code></li>)}</ul></div>}
            <p className="consequence">{t(preview.action === "open" ? "projects.openConsequence" : preview.action === "register" ? "projects.registerConsequence"
              : preview.action === "push" ? "projects.pushConsequence" : "projects.createConsequence", { name: preview.name })}</p>
          </section>}
          {failure && <p role="alert">{t(ERRORS[failure] ?? (mode === "open" ? "projects.openFailed" : "projects.createFailed"))}</p>}
          {oversized.length > 0 && <div><h3>{t("projects.oversized")}</h3>
            <ul>{oversized.map(path => <li key={path}><code>{path}</code></li>)}</ul></div>}
          <div className="plate-foot"><button className="btn btn-primary" type="submit" disabled={busy || !repository.trim() || (mode === "create" && !name.trim())}>
            {t(busy ? "web.loading" : !preview ? "projects.reviewFiles" : failure === "github_push_failed" ? "projects.retry" : mode === "open" ? "projects.open" : "projects.submit")}
          </button></div>
        </form>}</div>
    </Dialog.Content>
  </Dialog.Root>;
}

/** Project and run selection keep their home on Overview after the old project screen is removed. */
export function ProjectsScreen({ teams, runs, loading, onOpenProject, onOpenRun, onNewWork, onCreate, onOpenExisting }: {
  teams: TeamSummary[] | undefined; runs: RunSummary[] | undefined; loading: boolean;
  onOpenProject: (id: string) => void; onOpenRun: (id: string) => void; onNewWork: (id: string) => void;
  onCreate: (opener: HTMLButtonElement) => void; onOpenExisting?: (opener: HTMLButtonElement) => void;
}) {
  const { t } = useTranslation();
  return <div className="page"><div className="page-head"><h1 className="display">{t("projects.title")}</h1>
    <div className="ui-project-actions"><button className="btn btn-outline" onClick={event => onOpenExisting?.(event.currentTarget)}>{t("projects.open")}</button>
      <button className="btn btn-primary" onClick={event => onCreate(event.currentTarget)}>{t("projects.create")}</button></div></div>
    {loading ? <p role="status">{t("web.loading")}</p> : !teams?.length ? <p className="muted">{t("projects.empty")}</p>
      : <div className="ui-project-list">{teams.map(team => {
        const run = latestRunFor(runs, team.id);
        return <section className="plate ui-project-card" key={team.id}>
          <button className="ui-project-open" onClick={() => onOpenProject(team.id)}><strong>{team.name}</strong><span className="mono muted">{team.repository}</span></button>
          <div className="seats"><span className="chip">{t(team.kind === "test" ? "records.testProject" : "records.project")}</span>{team.seats.map((seat, index) => <span className="chip" key={index}>{t(`role.${seat.role}`)} · {clientLabel(seat.client, t)}</span>)}</div>
          {run && <button className="ui-project-run" onClick={() => onOpenRun(run.id)}><span>{run.displayName}</span>
            <small className="muted">{t(run.phase === "planning" ? "planning.mode" : "execution.mode")} · {t(`status.run.${run.state}`)}
              {(run.resultCount ?? 0) > 0 && <> · {t("records.resultCount", { count: run.resultCount })}</>}</small></button>}
          <button className="btn btn-outline" onClick={() => onNewWork(team.id)}>{t("team.teams.newWork")}</button>
        </section>;
      })}</div>}
  </div>;
}
