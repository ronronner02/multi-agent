import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { createInterfaceI18n, type InterfaceI18n, type InterfaceLanguage } from "@openrig/i18n";
import { I18nextProvider, useTranslation } from "react-i18next";
import { CheckCircle2, ChartColumn, ChevronDown, House, LayoutGrid, Moon, Search, Settings as SettingsIcon, SquareCheck, Sun } from "lucide-react";
import { version } from "../../package.json";
import { Card } from "../components/ui/card.js";
import { Button } from "../components/ui/button.js";
import { OwnerReadError, OwnerSessionProvider, useOwnerSession } from "../hooks/useOwnerSession.js";
import { useTeamRun } from "../hooks/useTeamRun.js";
import { NewTaskForm, RunSelect } from "./new-task.js";
import { Overview } from "./overview.js";
import { TasksScreen } from "./tasks.js";
import { WorkspaceView, type BrowseState } from "./workspace/workspace-view.js";
import { KnowledgeView } from "./knowledge/knowledge-view.js";
import { AgentStatus } from "./agent-status.js";
import { Activity } from "./activity.js";
import { BottomPanel, type TerminalTarget } from "./bottom-panel.js";
import { DecisionCard } from "./decision-card.js";
import { ReviewDecisions } from "./review-decisions.js";
import { RunStepper } from "./run-stepper.js";
import { SystemStatus } from "./system-status.js";
import "./team.css";

export const INTERFACE_LANGUAGE_KEY = "openrig.interfaceLanguage";

/** The six destinations the shell ships; the order is the sidebar order. */
export const TEAM_SECTIONS = ["overview", "workspace", "tasks", "reviews", "analytics", "settings"] as const;
export type TeamSection = (typeof TEAM_SECTIONS)[number];

/**
 * Destinations the retired eight-item rail exposed. Their deep links stay valid by opening the
 * destination that now owns the same evidence instead of a blank page.
 */
const LEGACY_SECTIONS: Readonly<Record<string, TeamSection>> = {
  agents: "workspace", logs: "workspace", knowledge: "workspace", decisions: "reviews",
};

export function teamSection(pathname: string): TeamSection {
  const raw = pathname.split("/")[2] || "overview";
  if (LEGACY_SECTIONS[raw]) return LEGACY_SECTIONS[raw]!;
  return (TEAM_SECTIONS as readonly string[]).includes(raw) ? (raw as TeamSection) : "overview";
}

export const TEAM_THEME_KEY = "openrig.teamTheme";
export type TeamTheme = "dark" | "light";

export function readTeamTheme(): TeamTheme {
  try {
    return localStorage.getItem(TEAM_THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function writeTeamTheme(theme: TeamTheme): void {
  try {
    localStorage.setItem(TEAM_THEME_KEY, theme);
  } catch {
    // The choice still applies to this load when storage is unavailable.
  }
}

const NAV_ICONS = {
  overview: House, workspace: LayoutGrid, tasks: SquareCheck, reviews: CheckCircle2, analytics: ChartColumn, settings: SettingsIcon,
} as const;

const USAGE_LABELS = ["costUsd", "inputTokens", "outputTokens"] as const;

export function Pairing() {
  const { t } = useTranslation();
  const { paired, pair, revoke } = useOwnerSession();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return <Card className="team-card team-pairing" role="region" aria-label={t("web.pair")}>
    {paired ? <div className="team-card-heading"><p>{t("web.paired")}</p><Button variant="outline" disabled={busy} onClick={async () => {
      setBusy(true); setFailed(false);
      try { await revoke(); } catch { setFailed(true); } finally { setBusy(false); }
    }}>{t("web.revoke")}</Button></div> : <>
      <p role="status">{t("web.pairRequired")}</p><p className="team-muted">{t("web.pairHelp")}</p>
      <form onSubmit={async e => {
        e.preventDefault(); setBusy(true); setFailed(false);
        try { await pair(code); setCode(""); } catch { setFailed(true); } finally { setBusy(false); }
      }}><label>{t("web.pairCode")}<input type="password" autoComplete="off" value={code} onChange={e => setCode(e.target.value)} /></label>
        <Button variant="outline" type="submit" disabled={busy || !code}>{t("web.pair")}</Button></form>
    </>}
    {failed && <p role="alert">{t(paired ? "web.sessionError" : "web.pairError")}</p>}
  </Card>;
}

/** The command strip's search field. It jumps to Tasks with the query, and Ctrl K focuses it. */
export function GlobalSearch({ onSearch }: { onSearch: (query: string) => void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focus = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); input.current?.focus(); }
    };
    window.addEventListener("keydown", focus);
    return () => window.removeEventListener("keydown", focus);
  }, []);
  return <form className="ui-search" role="search" onSubmit={event => { event.preventDefault(); onSearch(value.trim()); }}>
    <Search aria-hidden="true" />
    <input ref={input} value={value} onChange={event => setValue(event.target.value)}
      placeholder={t("shell.searchJump")} aria-label={t("shell.searchJump")} autoComplete="off" />
    <kbd>{t("shell.ctrlK")}</kbd>
  </form>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return <header className="ui-page-head">
    <div><h1>{title}</h1>{subtitle && <p className="ui-subtitle"><code>{subtitle}</code></p>}</div>
    {actions && <div className="ui-page-actions">{actions}</div>}
  </header>;
}

/**
 * The app shell itself: sidebar, command strip and the destination's content. It holds no data
 * and no router, so the same frame serves the web app and the desktop wrapper.
 */
export function ShellFrame({ language, section, theme, onTheme, runId, runPicker, project, coordinator, connection, notifications, onSelect, onSearch, children }: {
  language: InterfaceI18n; section: TeamSection; theme: TeamTheme; onTheme: (theme: TeamTheme) => void;
  runId: string; runPicker?: ReactNode; project: string; coordinator: { state: string; known: boolean }; connection: string;
  notifications: number | undefined; onSelect: (section: TeamSection) => void; onSearch: (query: string) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return <div className="team-shell" lang={language.language} data-ui-theme={theme} data-testid="team-shell">
    <aside className="ui-sidebar">
      <div className="ui-brand"><span className="ui-monogram" aria-hidden="true">M</span><span>{t("shell.appName")}</span></div>
      <div className="ui-project">
        <span className="ui-project-label">{t("shell.project")}</span>
        <strong>{project || "—"}</strong>
        <ChevronDown aria-hidden="true" />
      </div>
      <div className="ui-coordinator">
        <span className="ui-dot" data-state={coordinator.known ? coordinator.state : "unknown"} aria-hidden="true" />
        <span>{t("shell.coordinator")} · {coordinator.known ? t(coordinator.state === "running" ? "shell.active" : "shell.idle") : t("web.unknown")}</span>
      </div>
      <nav className="ui-nav" aria-label={t("shell.appName")}>
        {TEAM_SECTIONS.map(id => {
          const Icon = NAV_ICONS[id];
          return <a key={id} href={`#/team/${id}`} onClick={event => { event.preventDefault(); onSelect(id); }}
            aria-current={section === id ? "page" : undefined}><Icon aria-hidden="true" /><span>{t(`nav.${id}`)}</span></a>;
        })}
      </nav>
      <div className="ui-sidebar-foot">
        <button type="button" className="ui-theme-toggle" aria-label={t(theme === "dark" ? "shell.themeLight" : "shell.themeDark")}
          onClick={() => onTheme(theme === "dark" ? "light" : "dark")}>
          {theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
          <span>{t(theme === "dark" ? "settings.theme.light" : "settings.theme.dark")}</span>
        </button>
        <span className="ui-connection"><span className="ui-dot" data-state={connection === "shell.connected" ? "ok" : "unknown"} aria-hidden="true" />{t("shell.remoteMonitor")}</span>
      </div>
    </aside>
    <div className="ui-content">
      <header className="ui-topstrip">
        <div className="ui-breadcrumb"><span>{project || t("shell.project")}</span><span aria-hidden="true">/</span>{runPicker ?? <code>{runId || "—"}</code>}</div>
        <GlobalSearch onSearch={onSearch} />
        <div className="ui-top-meta">
          <span className="ui-status" role="status"><span className="ui-dot" data-state={connection === "shell.connected" ? "ok" : "unknown"} aria-hidden="true" />{t(connection as "shell.connected")}</span>
          <span className="ui-bell" aria-label={`${t("shell.notifications")}: ${notifications ?? "—"}`}>
            <span aria-hidden="true">◔</span>{notifications !== undefined && notifications > 0 && <span className="ui-badge">{notifications}</span>}
          </span>
        </div>
      </header>
      <main className="ui-main">{children}</main>
    </div>
  </div>;
}

function SettingsScreen({ language, theme, onTheme }: {
  language: InterfaceI18n; theme: TeamTheme; onTheme: (theme: TeamTheme) => void;
}) {
  const { t } = useTranslation();
  const { read } = useTeamRun("");
  return <>
    <PageHeader title={t("settings.title")} />
    <Card className="team-card" role="region" aria-label={t("settings.appearance")}>
      <h2>{t("settings.appearance")}</h2>
      <div className="ui-field">
        <label>{t("language.label")}<select value={language.language} onChange={event => void language.changeLanguage(event.target.value as InterfaceLanguage)}>
          <option value="zh-CN">{t("language.zh-CN")}</option><option value="en">{t("language.en")}</option></select></label>
        <label>{t("settings.theme")}<select value={theme} onChange={event => onTheme(event.target.value as TeamTheme)}>
          <option value="dark">{t("settings.theme.dark")}</option><option value="light">{t("settings.theme.light")}</option></select></label>
      </div>
      <p className="team-muted">{t("settings.themeHelp")}</p>
    </Card>
    <Card className="team-card" role="region" aria-label={t("settings.connection")}>
      <h2>{t("settings.connection")}</h2><p className="team-muted"><code>v{version}</code></p>
      <Pairing />
    </Card>
    <Card className="team-card" role="region" aria-label={t("settings.plan")}>
      <h2>{t("settings.plan")}</h2>
      <p className="team-muted">{read.data?.run.binding.planRef ?? t("web.noRun")}</p>
    </Card>
  </>;
}

function ManagedShell({ language }: { language: InterfaceI18n }) {
  const { t } = useTranslation();
  const { paired } = useOwnerSession();
  const searchParams = useSearch({ from: "/team" });
  const runId = searchParams.run ?? "";
  const pathname = useRouterState({ select: state => state.location.pathname });
  const section = teamSection(pathname);
  const navigate = useNavigate();
  const data = useTeamRun(runId);
  const [now, setNow] = useState(Date.now);
  const [theme, setTheme] = useState<TeamTheme>(readTeamTheme);
  const [workspaceBrowse, setWorkspaceBrowse] = useState<BrowseState & { runId: string }>({ runId, path: "", source: "" });
  const [knowledgeBrowse, setKnowledgeBrowse] = useState<BrowseState & { runId: string }>({ runId, path: "", source: "target" });
  const [evidenceTab, setEvidenceTab] = useState("logs");
  const [target, setTarget] = useState<TerminalTarget>(null);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(timer); }, []);
  useEffect(() => { writeTeamTheme(theme); }, [theme]);

  const read = data.read.data;
  const error = data.read.error ?? data.events.error ?? data.health.error;
  const readAt = runId ? Math.min(data.read.dataUpdatedAt, Date.parse(read?.generatedAt ?? "") || 0) : data.health.dataUpdatedAt;
  const age = readAt ? Math.max(0, Math.floor((now - readAt) / 1_000)) : null;
  const fresh = age !== null && now - readAt <= 5_000;
  const connection = !paired ? "web.pairRequired" : error instanceof OwnerReadError ? (error.status === 404 ? "web.notFound" : "web.error")
    : error instanceof TypeError ? "web.disconnected" : error ? "web.error" : !runId ? "web.noRun" : age === null ? "web.loading" : fresh ? "shell.connected" : "web.stale";
  const pending = paired && fresh ? read?.approvals.filter(item => item.state === "pending") : undefined;
  const coordinator = read?.attempts.find(attempt => attempt.role === "lead");
  const go = (next: TeamSection, query?: string) => void navigate({
    to: "/team/$section", params: { section: next }, search: { run: runId || undefined, q: query || undefined },
  });

  return <ShellFrame language={language} section={section} theme={theme} onTheme={setTheme}
    runId={runId} runPicker={paired ? <RunSelect current={runId} /> : undefined}
    project={read?.run.rigId ?? ""} coordinator={{ state: coordinator?.state ?? "unknown", known: !!coordinator }}
    connection={connection} notifications={pending?.length} onSelect={go} onSearch={query => go("tasks", query)}>
    {!paired && section !== "settings" && <Pairing />}
    {section === "settings" ? <SettingsScreen language={language} theme={theme} onTheme={setTheme} /> : <>
      {!runId && <Card className="team-card ui-empty" role="status"><strong>{t("shell.noRun")}</strong>
        <p className="team-muted">{t("web.discovery")}</p></Card>}
      {section === "overview" && <Overview read={read} run={read?.run} now={now}
        onInspect={() => go("workspace")} onOpenTasks={() => go("tasks")} />}
      {section === "tasks" && <TasksScreen read={read} runId={runId} query={searchParams.q} />}
      {section === "workspace" && <>
        <PageHeader title={t("nav.workspace")} subtitle={runId || undefined} />
        <WorkspaceView runId={runId} state={workspaceBrowse.runId === runId ? workspaceBrowse : { path: "", source: "" }}
          onState={state => setWorkspaceBrowse({ ...state, runId })} tasks={read?.tasks} />
        <KnowledgeView runId={runId} state={knowledgeBrowse.runId === runId ? knowledgeBrowse : { path: "", source: "target" }}
          onState={state => setKnowledgeBrowse({ ...state, runId })} tasks={read?.tasks} />
        <AgentStatus health={data.health.data} runId={runId} attempts={read?.attempts} />
        <Activity read={read} replay={data.events.data} />
        <BottomPanel tab={evidenceTab} onTab={setEvidenceTab} read={read} available={paired && !error && fresh}
          target={target} onTarget={setTarget} />
      </>}
      {section === "reviews" && <>
        <PageHeader title={t("nav.reviews")} subtitle={runId || undefined} />
        <DecisionCard read={paired && !error && fresh ? read : undefined} available={paired && !error && fresh} now={now}
          refresh={() => data.read.refetch({ throwOnError: true })} />
        <ReviewDecisions tasks={read?.tasks} />
      </>}
      {section === "analytics" && <>
        <PageHeader title={t("nav.analytics")} subtitle={runId || undefined} />
        <RunStepper workflow={read?.workflow} />
        <SystemStatus run={read?.run} health={data.health.data} available={paired && !error && fresh} now={now} />
        <Card className="team-card" role="region" aria-label={t("web.usage")}><h2>{t("web.usage")}</h2>
          <dl className="team-facts">{USAGE_LABELS.map(name => <div key={name}>
            <dt>{t(name === "costUsd" ? "web.cost" : name === "inputTokens" ? "web.inputTokens" : "web.outputTokens")}</dt>
            <dd>{read?.run.usage[name].value ?? t("web.unknown")}<small>{read?.run.usage[name].reason}</small></dd>
          </div>)}</dl>
        </Card>
      </>}
    </>}
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
  return language && <I18nextProvider i18n={language.instance}><OwnerSessionProvider><ManagedShell language={language} /></OwnerSessionProvider></I18nextProvider>;
}
