import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { createInterfaceI18n, type InterfaceI18n } from "@openrig/i18n";
import { I18nextProvider, useTranslation } from "react-i18next";
import { ChevronLeft, MoreHorizontal } from "./glyphs.js";
import { OwnerReadError, OwnerSessionProvider, useOwnerSession } from "../hooks/useOwnerSession.js";
import { useTeamRun } from "../hooks/useTeamRun.js";
import type { TeamOwnerRead } from "@openrig/daemon/team-control";
import { useRuns, useTeams } from "./hooks.js";
import { TeamsScreen } from "./teams-screen.js";
import { RunHome } from "./run-home.js";
import { TaskScreen } from "./task-screen.js";
import { BranchScreen } from "./branch-screen.js";
import { SettingsScreen } from "./settings.js";
import { StartRunForm, NewWorkSheet } from "./new-task.js";
import { isFinished } from "./display.js";
import { isRunActive } from "./clients.js";
import { useThemePreference } from "./theme.js";
import "./fonts.js";
import "./team.css";

export const INTERFACE_LANGUAGE_KEY = "openrig.interfaceLanguage";

/**
 * U10 — the team surface's map.
 *
 * Four destinations and one settings pane, reached from the overflow menu. Everything the old
 * six-section rail carried — the overview metrics, analytics, the workspace browser, the
 * four-column board, the reviews list — is a view of these four, or is gone.
 */
export const TEAM_SECTIONS = ["teams", "run", "task", "branch"] as const;
export type TeamSection = (typeof TEAM_SECTIONS)[number];

/** Retired destinations keep their deep links by opening the screen that now owns the work. */
const LEGACY_SECTIONS: Readonly<Record<string, TeamSection | "settings">> = {
  overview: "run", tasks: "task", reviews: "task", workspace: "task", analytics: "run", settings: "settings",
};

export function teamSection(pathname: string): TeamSection | "settings" {
  const raw = pathname.split("/")[2] || "teams";
  if (LEGACY_SECTIONS[raw]) return LEGACY_SECTIONS[raw]!;
  return (TEAM_SECTIONS as readonly string[]).includes(raw) ? (raw as TeamSection) : "teams";
}

/** The signed-out state: one card, the pairing field, and nothing else. */
export function Pairing() {
  const { t } = useTranslation();
  const { paired, pair, revoke } = useOwnerSession();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return <div className="page page-narrow" style={{ paddingTop: 96 }}>
    <section className="plate" aria-label={t("web.pair")}>
      {paired ? <>
        <h2 className="plate-title">{t("web.paired")}</h2>
        <div className="plate-foot"><button className="btn btn-outline" disabled={busy} onClick={async () => {
          setBusy(true); setFailed(false);
          try { await revoke(); } catch { setFailed(true); } finally { setBusy(false); }
        }}>{t("web.revoke")}</button></div>
      </> : <>
        <h2 className="plate-title">{t("web.pairRequired")}</h2>
        <form onSubmit={async event => {
          event.preventDefault(); setBusy(true); setFailed(false);
          try { await pair(code); setCode(""); } catch { setFailed(true); } finally { setBusy(false); }
        }} style={{ display: "grid", gap: 12 }}>
          <div className="field">
            <label htmlFor="pair-code">{t("web.pairCode")}</label>
            <input id="pair-code" className="input mono" type="password" autoComplete="off"
              value={code} onChange={event => setCode(event.target.value)} />
          </div>
          <div className="plate-foot">
            <button className="btn btn-primary" type="submit" disabled={busy || !code}>{t("web.pair")}</button>
          </div>
        </form>
      </>}
      {failed && <p role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>{t(paired ? "web.sessionError" : "web.pairError")}</p>}
    </section>
  </div>;
}

/**
 * The frame itself: a 56px bar and the screen below it. It holds no data and no router, so the
 * same frame serves the browser, the desktop wrapper and the tests.
 */
export function ShellFrame({ language, crumbs, onLanguage, onSettings, action, children }: {
  language: InterfaceI18n;
  crumbs: ReactNode;
  onLanguage: (next: "zh-CN" | "en") => void;
  onSettings: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return <div className="team-shell" lang={language.language} data-testid="team-shell">
    <header className="topbar">
      <div className="crumbs">{crumbs}</div>
      <div className="topbar-right">
        {action}
        <div className="lang" role="group" aria-label={t("team.settings.language")}>
          <button aria-pressed={language.language === "zh-CN"} onClick={() => onLanguage("zh-CN")}>中</button>
          <button aria-pressed={language.language === "en"} onClick={() => onLanguage("en")}>EN</button>
        </div>
        <button className="more" aria-label={t("team.settings.title")} onClick={onSettings}><MoreHorizontal /></button>
      </div>
    </header>
    {children}
  </div>;
}

/**
 * Whether the run screen offers the next run.
 *
 * The run itself stays "approved" after its work finishes and after a merge, so the state alone
 * cannot say the run is done: an active run with open tasks is the only case that hides the
 * entry, because that is the only case where the team is already busy.
 */
export function showsNewWork(read?: TeamOwnerRead): boolean {
  if (!read) return false;
  if (!isRunActive(read.run)) return true;
  return read.tasks.length > 0 && read.tasks.every(task => isFinished(task));
}

function ManagedShell({ language, onLanguage }: { language: InterfaceI18n; onLanguage: (next: "zh-CN" | "en") => void }) {
  const { t } = useTranslation();
  const { paired } = useOwnerSession();
  const search = useSearch({ from: "/team" });
  const runId = search.run ?? "";
  const taskId = search.task ?? "";
  const pathname = useRouterState({ select: state => state.location.pathname });
  const section = teamSection(pathname);
  const navigate = useNavigate();
  const data = useTeamRun(runId);
  const teams = useTeams();
  const runs = useRuns();
  useThemePreference();

  const read = data.read.data;
  const error = data.read.error ?? data.events.error ?? data.health.error;
  const connection = !paired ? "web.pairRequired"
    : error instanceof OwnerReadError ? (error.status === 404 ? "web.notFound" : "web.error")
    : error instanceof TypeError ? "web.disconnected" : error ? "web.error"
    : !runId ? "web.noRun" : data.read.isPending ? "web.loading" : "shell.connected";

  const team = read ? teams.data?.find(entry => entry.id === read.run.rigId) : undefined;
  const teamName = team?.name ?? runs.data?.find(entry => entry.id === runId)?.rigName ?? "";
  const runName = read?.run.displayName ?? runs.data?.find(entry => entry.id === runId)?.displayName ?? "";

  const go = (next: TeamSection | "settings", extra?: { run?: string; task?: string }) => void navigate({
    to: "/team/$section", params: { section: next },
    search: { run: (extra?.run ?? runId) || undefined, task: extra?.task ?? (next === "task" ? taskId || undefined : undefined) },
  });

  const crumbs = <>
    <a className="crumb" href="/team/teams" onClick={event => { event.preventDefault(); go("teams", { run: undefined, task: undefined }); }}>
      {section === "teams" ? null : <ChevronLeft />}
      {section === "teams" ? (t("shell.appName")) : (teamName || t("team.teams.title"))}
    </a>
    {section !== "teams" && runName && <>
      <span className="crumb-sep">/</span>
      <button className="crumb" onClick={() => go("run")}>{runName}</button>
    </>}
  </>;

  const [newWork, setNewWork] = useState(false);
  // A run that is no longer doing work offers the next one: the owner can keep a team busy
  // without starting from the teams list.
  const canStartWork = showsNewWork(read) && runId !== "";

  const frame = (children: ReactNode) => <ShellFrame language={language} crumbs={crumbs}
    onLanguage={onLanguage} onSettings={() => go("settings")}
    action={canStartWork ? <button className="btn btn-quiet" style={{ fontSize: 13 }}
      onClick={() => setNewWork(true)}>{t("team.teams.newWork")}</button> : undefined}>
    {children}
    {canStartWork && <NewWorkSheet teams={teams.data} teamId={read!.run.rigId} open={newWork}
      onOpenChange={setNewWork} onStarted={nextRun => { setNewWork(false); go("run", { run: nextRun, task: undefined }); }} />}
  </ShellFrame>;

  if (!paired) return frame(<Pairing />);
  if (section === "settings") return frame(<SettingsScreen language={language} connection={connection}
    isolation={data.health.data?.runtime?.isolation ?? null} address={window.location.origin}
    onClose={() => go("teams", { run: undefined, task: undefined })} />);

  if (section === "teams") return frame(<TeamsScreen teams={teams.data} runs={runs.data}
    loading={teams.isPending} onOpenTeam={teamId => go("run", { run: latestRunId(runs.data, teamId), task: undefined })}
    onOpenRun={nextRun => go("run", { run: nextRun, task: undefined })} />);

  if (!runId) {
    return frame(<div className="page page-narrow" style={{ paddingTop: 48 }}>
      <div className="page-head"><h1 className="display">{t("team.run.noRun")}</h1></div>
      <StartRunForm teams={teams.data} onStarted={nextRun => go("run", { run: nextRun, task: undefined })} />
    </div>);
  }

  if (section === "task") return frame(<TaskScreen read={read} runId={runId} taskId={taskId} seats={read?.seats ?? []}
    onBack={() => go("run")} />);

  if (section === "branch") return frame(<BranchScreen read={read} runId={runId} onBack={() => go("run")} />);

  return frame(<RunHome read={read} runId={runId} available={paired && !error} now={Date.now()}
    onOpenTask={next => go("task", { task: next })} onOpenBranch={() => go("branch")} />);
}

function latestRunId(runs: { id: string; rigId: string }[] | undefined, teamId: string): string | undefined {
  return (runs ?? []).find(run => run.rigId === teamId)?.id;
}

export function TeamShell() {
  const [language, setLanguage] = useState<InterfaceI18n | null>(null);
  useEffect(() => {
    let active = true;
    void createInterfaceI18n({ preference: {
      read() { try { return localStorage.getItem(INTERFACE_LANGUAGE_KEY); } catch { return undefined; } },
      write(value) { try { localStorage.setItem(INTERFACE_LANGUAGE_KEY, value); } catch { /* The current language still changes. */ } },
    } }).then(value => { if (active) setLanguage(value); });
    return () => { active = false; };
  }, []);
  const change = (next: "zh-CN" | "en") => { if (!language) return; void language.changeLanguage(next).then(() => setLanguage(language)); };
  return language && <I18nextProvider i18n={language.instance}>
    <OwnerSessionProvider><ManagedShell language={language} onLanguage={change} /></OwnerSessionProvider>
  </I18nextProvider>;
}