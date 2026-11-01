import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { createInterfaceI18n, type InterfaceI18n } from "@openrig/i18n";
import { I18nextProvider, useTranslation } from "react-i18next";
import type { TeamAttemptView } from "@openrig/daemon/team-control";
import { Bell, TriangleAlert, CheckCircle2, ChartColumn, ChevronDown, House, LayoutGrid, Moon, Search, Settings as SettingsIcon, SquareCheck, Sun } from "lucide-react";
import { Card } from "../components/ui/card.js";
import { Button } from "../components/ui/button.js";
import { OwnerReadError, OwnerSessionProvider, useOwnerSession } from "../hooks/useOwnerSession.js";
import { useTeamRun } from "../hooks/useTeamRun.js";
import { RunSelect, NoRunCard } from "./new-task.js";
import { Overview } from "./overview.js";
import { TasksScreen } from "./tasks.js";
import { WorkspaceScreen } from "./workspace/workspace-screen.js";
import type { BrowseState } from "./workspace/workspace-view.js";
import { ReviewsScreen } from "./reviews.js";
import { BottomPanel, type TerminalTarget } from "./bottom-panel.js";
import { AnalyticsScreen } from "./analytics.js";
import { SettingsScreen } from "./settings.js";
import { useThemePreference, type TeamTheme } from "./theme.js";
import "./team.css";
import "../skins/shuimo-danqing/skin.css";

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

const NAV_ICONS = {
  overview: House, workspace: LayoutGrid, tasks: SquareCheck, reviews: CheckCircle2, analytics: ChartColumn, settings: SettingsIcon,
} as const;

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

function InkBackdrop() {
  const [motion, setMotion] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setMotion(!query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return <div className="team-backdrop" aria-hidden="true">
    {motion && <video autoPlay muted loop playsInline preload="none" tabIndex={-1}
      src="/skins/shuimo-danqing/shuimo-danqing-loop.mp4" />}
  </div>;
}

/**
 * The app shell itself: sidebar, command strip and the destination's content. It holds no data
 * and no router, so the same frame serves the web app and the desktop wrapper.
 */
export function ShellFrame({ language, section, theme, onTheme, runId, runPicker, project, coordinator, connection, snapshotAge, notifications, hrefFor, onSelect, onSearch, children }: {
  language: InterfaceI18n; section: TeamSection; theme: TeamTheme; onTheme: (theme: TeamTheme) => void;
  runId: string; runPicker?: ReactNode; project: string; coordinator: { state: TeamAttemptView["state"]; known: boolean }; connection: string; snapshotAge?: number | null;
  notifications: number | undefined; hrefFor: (section: TeamSection) => string;
  onSelect: (section: TeamSection) => void; onSearch: (query: string) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return <div className="team-shell" lang={language.language} data-ui-theme={theme} data-testid="team-shell">
    {theme === "ink" && <InkBackdrop />}
    <aside className="ui-sidebar">
      <div className="ui-brand"><span className="ui-monogram" aria-hidden="true">M</span><span>{t("shell.appName")}</span></div>
      <div className="ui-project">
        <span className="ui-project-label">{t("shell.project")}</span>
        <strong>{project || "—"}</strong>
        <ChevronDown aria-hidden="true" />
      </div>
      <div className="ui-coordinator">
        <span className="ui-dot" data-state={coordinator.known ? coordinator.state : "unknown"} aria-hidden="true" />
        <span>{t("shell.coordinator")} · {coordinator.known ? t(coordinator.state === "running" ? "shell.active" : `status.attempt.${coordinator.state}`) : t("web.unknown")}</span>
      </div>
      <nav className="ui-nav" aria-label={t("shell.appName")}>
        {TEAM_SECTIONS.map(id => {
          const Icon = NAV_ICONS[id];
          return <a key={id} href={hrefFor(id)} onClick={event => {
            // Plain clicks stay in the app; a modified click keeps the browser's own behaviour.
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault(); onSelect(id);
          }} aria-current={section === id ? "page" : undefined}><Icon aria-hidden="true" /><span>{t(`nav.${id}`)}</span></a>;
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
          <button type="button" className="ui-bell" onClick={() => onSelect("reviews")} aria-label={`${t("shell.notifications")}: ${notifications ?? "—"}`}>
            <Bell aria-hidden="true" />{notifications !== undefined && notifications > 0 && <span className="ui-badge">{notifications}</span>}
          </button>
        </div>
      </header>
      <main className="ui-main">
        {["web.stale", "web.disconnected", "web.error", "web.notFound"].includes(connection) && <div className="ui-snapshot-warning">
          <TriangleAlert aria-hidden="true" />
          <div><p role="alert"><strong>{t(connection as "web.stale")}</strong> · {t("shell.snapshotWarning")}</p>
            {snapshotAge != null && <small>{t("shell.snapshotAge", { seconds: snapshotAge })}</small>}</div>
        </div>}
        {children}
      </main>
    </div>
  </div>;
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
  const { preference, theme, setPreference } = useThemePreference();
  const [workspaceBrowse, setWorkspaceBrowse] = useState<BrowseState & { runId: string }>({ runId, path: "", source: "" });
  const [knowledgeBrowse, setKnowledgeBrowse] = useState<BrowseState & { runId: string }>({ runId, path: "", source: "target" });
  const [evidenceTab, setEvidenceTab] = useState("logs");
  const [target, setTarget] = useState<TerminalTarget>(null);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(timer); }, []);

  const read = data.read.data;
  const error = data.read.error ?? data.events.error ?? data.health.error;
  const readAt = runId ? Math.min(data.read.dataUpdatedAt, Date.parse(read?.generatedAt ?? "") || 0) : data.health.dataUpdatedAt;
  const age = readAt ? Math.max(0, Math.floor((now - readAt) / 1_000)) : null;
  const fresh = age !== null && now - readAt <= 5_000;
  const connection = !paired ? "web.pairRequired" : error instanceof OwnerReadError ? (error.status === 404 ? "web.notFound" : "web.error")
    : error instanceof TypeError ? "web.disconnected" : error ? "web.error" : !runId ? "web.noRun" : age === null ? "web.loading" : fresh ? "shell.connected" : "web.stale";
  const pending = paired && !error && fresh ? read?.approvals.filter(item => item.state === "pending") : undefined;
  const coordinator = read?.attempts.filter(attempt => attempt.role === "lead").at(-1);
  const go = (next: TeamSection, query?: string) => void navigate({
    to: "/team/$section", params: { section: next }, search: { run: runId || undefined, q: query || undefined },
  });

  return <ShellFrame language={language} section={section} theme={theme} onTheme={() => setPreference(theme === "dark" ? "light" : "dark")}
    runId={runId} runPicker={paired ? <RunSelect current={runId} /> : undefined}
    project={read?.run.rigId ?? ""} coordinator={{ state: coordinator?.state ?? "unknown", known: !!coordinator }}
    connection={connection} snapshotAge={runId ? age : null} notifications={pending?.length}
    hrefFor={next => `/team/${next}${runId ? `?run=${encodeURIComponent(runId)}` : ""}`}
    onSelect={go} onSearch={query => go("tasks", query)}>
    {!paired && section !== "settings" && <Pairing />}
    {section === "settings" ? <SettingsScreen language={language} theme={preference} onTheme={setPreference}
      connection={connection} isolation={data.health.data?.runtime?.isolation ?? null}
      address={window.location.origin} planRef={read?.run.binding.planRef} /> : <>
      {!runId && <NoRunCard />}
      {section === "overview" && <Overview read={read} run={read?.run} now={now}
        onInspect={() => go("workspace")} onOpenTasks={() => go("tasks")} onOpenReviews={() => go("reviews")} />}
      {section === "tasks" && <TasksScreen read={read} runId={runId} query={searchParams.q} />}
      {section === "workspace" && <WorkspaceScreen read={read} runId={runId} health={data.health.data}
        available={paired && !error && fresh} replay={data.events.data?.events}
        browse={{ state: workspaceBrowse.runId === runId ? workspaceBrowse : { path: "", source: "" },
          onState: state => setWorkspaceBrowse({ ...state, runId }) }}
        knowledge={{ state: knowledgeBrowse.runId === runId ? knowledgeBrowse : { path: "", source: "target" },
          onState: state => setKnowledgeBrowse({ ...state, runId }) }}
        evidence={{ tab: evidenceTab, onTab: setEvidenceTab, target, onTarget: setTarget }} />}
      {section === "reviews" && <ReviewsScreen read={read} runId={runId} available={paired && !error && fresh}
        refresh={() => data.read.refetch({ throwOnError: true })} />}
      {section === "analytics" && <AnalyticsScreen read={read} runId={runId} />}
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
