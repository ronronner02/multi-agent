import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { createInterfaceI18n, type InterfaceI18n, type MessageKey } from "@openrig/i18n";
import { I18nextProvider, useTranslation } from "react-i18next";
import { Bell, ChartColumn, CheckCircle2, GitBranch, House, LayoutGrid, Menu, MessageSquare, Search, Settings, SquareCheck, X } from "lucide-react";
import { OwnerReadError, OwnerSessionProvider, useOwnerSession } from "../hooks/useOwnerSession.js";
import { useTeamRun } from "../hooks/useTeamRun.js";
import type { TeamOwnerRead } from "@openrig/daemon/team-control";
import { latestRunFor, useIntegration, useRuns, useTeamChat, useTeams } from "./hooks.js";
import { CreateProject, ProjectsScreen } from "./create-project.js";
import { Overview } from "./overview.js";
import { TasksScreen } from "./tasks.js";
import { WorkspaceScreen } from "./workspace/workspace-screen.js";
import { ReviewsScreen } from "./reviews.js";
import { SettingsScreen } from "./settings.js";
import { AnalyticsScreen } from "./analytics.js";
import { StartRunForm, NewWorkSheet } from "./new-task.js";
import { isFinished, readableBranch, taskName } from "./display.js";
import { isRunActive } from "./clients.js";
import { TEAM_THEME_PREFERENCES, useThemePreference } from "./theme.js";
import { Background, useBackgroundPreference } from "./background.js";
import { EntryFrame, GithubGate } from "./github-gate.js";
import { ChatPanel, pendingOwnerDecisions } from "./chat-panel.js";
import { CommandPalette } from "./command-palette.js";
import "./fonts.js";
import "./team.css";

export const INTERFACE_LANGUAGE_KEY = "openrig.interfaceLanguage";
export const TEAM_SECTIONS = ["overview", "workspace", "tasks", "reviews", "analytics", "settings"] as const;
export type TeamSection = (typeof TEAM_SECTIONS)[number];
type TeamDestination = TeamSection;
const DESTINATIONS: readonly string[] = TEAM_SECTIONS;
const LEGACY_SECTIONS: Readonly<Record<string, TeamSection>> = { agents: "workspace", logs: "workspace", knowledge: "workspace", decisions: "reviews" };

export function teamSection(pathname: string): TeamDestination {
  const raw = pathname.split("/")[2] || "overview";
  return LEGACY_SECTIONS[raw] ?? (DESTINATIONS.includes(raw) ? raw as TeamDestination : "overview");
}

const SECTION_LABELS: Record<TeamDestination, MessageKey> = {
  overview: "nav.overview", workspace: "nav.workspace", tasks: "nav.tasks", reviews: "nav.reviews",
  analytics: "nav.analytics", settings: "nav.settings",
};
const NAV_ICONS = { overview: House, workspace: LayoutGrid, tasks: SquareCheck, reviews: CheckCircle2, analytics: ChartColumn, settings: Settings };

export function Pairing() {
  const { t } = useTranslation();
  const { paired, pair, revoke } = useOwnerSession();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return <div className="page page-narrow">
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

/** Restored sidebar and command strip, composed with the current owner-session screens. */
export function ShellFrame({ language, section, appearance, project, projectPicker, runName, runPicker, coordinator,
  connection, branch, notifications, canChat, onLanguage, hrefFor, onSelect, onOpenChat, onSearch, onCreateProject, action, backgroundMotion = true, children }: {
  language: InterfaceI18n; section: TeamDestination; appearance: ReturnType<typeof useThemePreference>;
  project: string; projectPicker?: ReactNode; runName: string; runPicker?: ReactNode; coordinator: MessageKey;
  connection: MessageKey; branch: string; notifications: number; canChat: boolean;
  onLanguage: (next: "zh-CN" | "en") => void; hrefFor: (section: TeamSection) => string;
  onSelect: (section: TeamSection) => void; onOpenChat: (opener: HTMLButtonElement) => void;
  onSearch: (opener: HTMLElement) => void; onCreateProject?: (opener: HTMLButtonElement) => void;
  action?: ReactNode; backgroundMotion?: boolean; children: ReactNode;
}) {
  const { t } = useTranslation();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const jump = (event: KeyboardEvent) => {
      if (canChat && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); setNavigationOpen(false);
        onSearch(navigationOpen && navigationTrigger.current ? navigationTrigger.current : document.activeElement as HTMLElement);
      }
    };
    window.addEventListener("keydown", jump);
    return () => window.removeEventListener("keydown", jump);
  }, [canChat, navigationOpen, onSearch]);
  const rail = <>
    <div className="ui-brand"><span className="ui-monogram" aria-hidden="true">M</span><span>{t("shell.appName")}</span></div>
    <div className="ui-project"><span className="ui-project-label">{t("shell.project")}</span>
      {projectPicker ?? <strong>{project || t("shell.allProjects")}</strong>}</div>
    <button className="ui-coordinator" aria-label={t("shell.coordinator")} disabled={!canChat} onClick={event => {
      const opener = navigationOpen && navigationTrigger.current ? navigationTrigger.current : event.currentTarget;
      setNavigationOpen(false); onOpenChat(opener);
    }}>
      <MessageSquare aria-hidden="true" /><span><strong>{t("shell.coordinator")}</strong><small>{t(coordinator)}</small></span>
    </button>
    <nav className="ui-nav" aria-label={t("shell.appName")}>{TEAM_SECTIONS.map(id => {
      const Icon = NAV_ICONS[id];
      return <a key={id} href={hrefFor(id)} aria-current={section === id ? "page" : undefined} onClick={event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); onSelect(id); setNavigationOpen(false);
      }}><Icon aria-hidden="true" /><span>{t(`nav.${id}`)}</span></a>;
    })}</nav>
    <div className="ui-sidebar-foot">
      {onCreateProject && <button className="btn btn-outline ui-new-project" onClick={event => {
        const opener = navigationOpen && navigationTrigger.current ? navigationTrigger.current : event.currentTarget;
        setNavigationOpen(false); onCreateProject(opener);
      }}>{t("projects.create")}</button>}
      {action && <div onClick={() => setNavigationOpen(false)}>{action}</div>}
      <label className="ui-appearance">{t("shell.appearance")}
        <select value={appearance.preference} onChange={event => appearance.setPreference(event.target.value as "dark" | "light" | "system")}>
          {TEAM_THEME_PREFERENCES.map(value => <option key={value} value={value}>{t(`settings.theme.${value}`)}</option>)}
        </select>
      </label>
      <div className="lang" role="group" aria-label={t("team.settings.language")}>
        <button aria-pressed={language.language === "zh-CN"} onClick={() => onLanguage("zh-CN")}>中</button>
        <button aria-pressed={language.language === "en"} onClick={() => onLanguage("en")}>EN</button>
      </div>
    </div>
  </>;
  const navSection = t(SECTION_LABELS[section]);
  return <Dialog.Root open={navigationOpen} onOpenChange={setNavigationOpen}>
    <div className="team-shell" lang={language.language} data-ui-theme={appearance.theme} data-testid="team-shell">
      <Background motion={backgroundMotion} />
      <aside className="ui-sidebar">{rail}</aside>
      <div className="ui-content">
        <header className="ui-topstrip">
          <Dialog.Trigger ref={navigationTrigger} className="ui-icon-button ui-menu-button" aria-label={t("shell.openNavigation")}><Menu aria-hidden="true" /></Dialog.Trigger>
          <div className="ui-breadcrumb"><span>{project || t("shell.project")}</span><span aria-hidden="true">/</span>
            {runPicker ?? (runName && <span className="ui-run-name">{runName}</span>)}<span className="ui-current-section">{navSection}</span></div>
          <button className="ui-search" disabled={!canChat} aria-label={t("shell.searchJump")} onClick={event => onSearch(event.currentTarget)}>
            <Search aria-hidden="true" /><span>{t("shell.searchJump")}</span><kbd>{t("shell.ctrlK")}</kbd>
          </button>
          <div className="ui-top-meta">
            <span className="ui-status" role="status"><span className="ui-dot" data-state={connection === "shell.connected" ? "ok" : "unknown"} aria-hidden="true" />{t(connection)}</span>
            <button className="ui-icon-button" disabled={!canChat} aria-label={t("shell.openChat")} onClick={event => onOpenChat(event.currentTarget)}><MessageSquare aria-hidden="true" /></button>
            <button className="ui-bell ui-icon-button" disabled={!canChat} aria-label={t("shell.notificationsCount", { count: notifications })} onClick={event => onOpenChat(event.currentTarget)}>
              <Bell aria-hidden="true" />{notifications > 0 && <span className="ui-badge">{notifications}</span>}
            </button>
          </div>
        </header>
        <div className="ui-main">
          {["web.stale", "web.disconnected", "web.error", "web.notFound"].includes(connection) && <p className="ui-snapshot-warning" role="alert">{t("shell.snapshotWarning")}</p>}
          {children}
        </div>
        <footer className="ui-footer"><span><GitBranch aria-hidden="true" /><span>{branch || t("shell.noBranch")}</span></span>
          <span>{t("shell.runtimeConnection")}: {t(connection)}</span></footer>
      </div>
      <Dialog.Overlay className="ui-dialog-overlay" />
      <Dialog.Content className="ui-mobile-sidebar" aria-describedby={undefined}>
        <Dialog.Title className="sr-only">{t("shell.navigation")}</Dialog.Title>
        <Dialog.Close className="ui-icon-button ui-menu-close" aria-label={t("shell.closeNavigation")}><X aria-hidden="true" /></Dialog.Close>
        {rail}
      </Dialog.Content>
    </div>
  </Dialog.Root>;
}

export function showsNewWork(read?: TeamOwnerRead): boolean {
  if (!read) return false;
  if (!isRunActive(read.run)) return true;
  return read.tasks.length > 0 && read.tasks.every(task => isFinished(task));
}

function ManagedShell({ language, onLanguage }: { language: InterfaceI18n; onLanguage: (next: "zh-CN" | "en") => void }) {
  const { paired } = useOwnerSession();
  const appearance = useThemePreference();
  const background = useBackgroundPreference();
  const frame = (content: ReactNode) => <EntryFrame language={language} onLanguage={onLanguage} appearance={appearance}
    backgroundMotion={background.motion}>{content}</EntryFrame>;
  return paired ? <GithubGate frame={frame}><ProjectShell language={language} onLanguage={onLanguage}
    appearance={appearance} background={background} /></GithubGate> : frame(<Pairing />);
}

function ProjectShell({ language, onLanguage, appearance, background }: {
  language: InterfaceI18n; onLanguage: (next: "zh-CN" | "en") => void;
  appearance: ReturnType<typeof useThemePreference>; background: ReturnType<typeof useBackgroundPreference>;
}) {
  const { t } = useTranslation();
  const { paired } = useOwnerSession();
  const search = useSearch({ from: "/team" });
  const runId = search.run ?? "";
  const taskId = search.task ?? "";
  const section = teamSection(useRouterState({ select: state => state.location.pathname }));
  const navigate = useNavigate();
  const data = useTeamRun(runId);
  const teams = useTeams();
  const runs = useRuns();
  const chat = useTeamChat(runId, paired);
  const integration = useIntegration(runId, paired);
  const [chatOpen, setChatOpen] = useState(false);
  const [draftContext, setDraftContext] = useState<{ runId: string; body: string }>();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newWorkFor, setNewWorkFor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const createOpener = useRef<HTMLElement>(null);
  const chatOpener = useRef<HTMLButtonElement>(null);
  const paletteOpener = useRef<HTMLElement>(null);
  const read = data.read.data;
  const error = data.read.error ?? data.events.error ?? data.health.error;
  const connection = !paired ? "web.pairRequired"
    : error instanceof OwnerReadError ? (error.status === 404 ? "web.notFound" : "web.error")
      : error instanceof TypeError ? "web.disconnected" : error ? "web.error"
        : (runId ? data.read.isPending : data.health.isPending) ? "web.loading" : "shell.connected";
  const selectedTeamId = read?.run.rigId ?? runs.data?.find(entry => entry.id === runId)?.rigId ?? search.team;
  const team = teams.data?.find(entry => entry.id === selectedTeamId);
  const teamName = team?.name ?? runs.data?.find(entry => entry.id === runId)?.rigName ?? "";
  const runName = read?.run.displayName ?? runs.data?.find(entry => entry.id === runId)?.displayName ?? "";
  const lead = read?.attempts.filter(attempt => attempt.role === "lead").at(-1);
  const coordinator: MessageKey = !read ? "web.unknown" : !lead ? "shell.idle" : lead.state === "running" ? "shell.active" : `status.attempt.${lead.state}`;
  const go = (next: TeamDestination, extra?: { run?: string; task?: string; team?: string }) => void navigate({
    to: "/team/$section", params: { section: next }, search: {
      run: extra && "run" in extra ? extra.run : runId || undefined,
      team: extra && "team" in extra ? extra.team : selectedTeamId,
      task: extra && "task" in extra ? extra.task : (["tasks", "workspace", "reviews"].includes(next) ? taskId || undefined : undefined),
    },
  });
  const canStartWork = showsNewWork(read) && runId !== "";
  const currentRuns = runs.data?.filter(run => run.rigId === selectedTeamId) ?? [];
  const openProject = (id: string) => go("overview", { team: id || undefined, run: latestRunFor(runs.data, id)?.id, task: undefined });
  const openCreate = (opener: HTMLButtonElement) => { createOpener.current = opener; setCreating(true); };
  let content: ReactNode;
  if (!paired) content = <Pairing />;
  else if (section === "settings") content = <SettingsScreen language={language} connection={connection}
    onLanguage={onLanguage} appearance={appearance} background={background} seats={read?.seats ?? team?.seats ?? []}
    isolation={data.health.data?.runtime?.isolation ?? null} address={window.location.origin} />;
  else if (section === "analytics") content = <AnalyticsScreen teamId={selectedTeamId} seats={read?.seats} />;
  else if (!runId) content = team ? <div className="page page-narrow"><div className="page-head"><h1 className="display">{team.name}</h1></div>
    <StartRunForm teams={teams.data} presetTeamId={team.id} onStarted={nextRun => go("overview", { run: nextRun })} /></div>
    : <ProjectsScreen teams={teams.data} runs={runs.data} loading={teams.isPending} onOpenProject={openProject}
      onOpenRun={nextRun => go("overview", { run: nextRun, task: undefined })} onNewWork={setNewWorkFor} onCreate={openCreate} />;
  else if (section === "tasks") content = <TasksScreen read={read} selectedTaskId={taskId}
    onSelect={task => go("tasks", { task })} onNewTask={() => { if (selectedTeamId) setNewWorkFor(selectedTeamId); }} />;
  else if (section === "workspace") content = <WorkspaceScreen key={"workspace-" + runId} read={read} selectedTaskId={taskId} />;
  else if (section === "reviews") content = <ReviewsScreen read={read} selectedTaskId={taskId} integration={integration.isError ? undefined : integration.data}
    onSelect={task => go("reviews", { task })} onAskLead={(task, opener) => {
      chatOpener.current = opener;
      setDraftContext({ runId, body: t("reviews.chatContext", { task: taskName(task, t) }) });
      setChatOpen(true);
    }} />;
  else content = <Overview read={read} chat={chat.data} integration={integration.data}
    onOpenTasks={() => go("tasks")} onOpenTask={task => go("tasks", { task })}
    onOpenChat={opener => { chatOpener.current = opener; setChatOpen(true); }} />;

  return <ShellFrame language={language} section={section} appearance={appearance} backgroundMotion={background.motion} project={teamName} runName={runName}
    coordinator={coordinator} connection={connection} branch={readableBranch(integration.data?.branch ?? "")}
    notifications={paired ? pendingOwnerDecisions(read, chat.data).length : 0} canChat={paired && !!runId}
    projectPicker={<select className="ui-project-picker" aria-label={t("shell.project")} value={team?.id ?? ""} onChange={event => openProject(event.target.value)}>
      <option value="">{t("shell.allProjects")}</option>{teams.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
    runPicker={currentRuns.length > 1 ? <select className="ui-runselect" aria-label={t("shell.run")} value={runId}
      onChange={event => go("overview", { run: event.target.value })}>{currentRuns.map(run => <option key={run.id} value={run.id}>{run.displayName}</option>)}</select> : undefined}
    onLanguage={onLanguage} hrefFor={next => `/team/${next}?${new URLSearchParams({ ...(runId ? { run: runId } : {}),
      ...(selectedTeamId ? { team: selectedTeamId } : {}), ...(["tasks", "workspace", "reviews"].includes(next) && taskId ? { task: taskId } : {}) })}`} onSelect={go}
    onOpenChat={opener => { chatOpener.current = opener; setChatOpen(true); }}
    onSearch={opener => { paletteOpener.current = opener; setPaletteOpen(true); }}
    onCreateProject={openCreate}
    action={canStartWork ? <button className="btn btn-quiet ui-new-work" onClick={() => { if (selectedTeamId) setNewWorkFor(selectedTeamId); }}>{t("team.teams.newWork")}</button> : undefined}>
    {content}
    {paired && runId && <ChatPanel key={runId} read={read} runId={runId} chat={chat.data} open={chatOpen} onOpenChange={setChatOpen} opener={chatOpener} draftContext={draftContext?.runId === runId ? draftContext : undefined} />}
    <CommandPalette open={paired && paletteOpen} onOpenChange={setPaletteOpen} tasks={paired ? read?.tasks ?? [] : []}
      onChoose={task => go("tasks", { task })} opener={paletteOpener} />
    <CreateProject open={creating} onOpenChange={setCreating} opener={createOpener}
      onCreated={created => go("overview", { team: created.id, run: undefined, task: undefined })} />
    {newWorkFor && <NewWorkSheet teams={teams.data} teamId={newWorkFor} open
      onOpenChange={open => { if (!open) setNewWorkFor(null); }} onStarted={nextRun => { setNewWorkFor(null); go("overview", { run: nextRun }); }} />}
  </ShellFrame>;
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
