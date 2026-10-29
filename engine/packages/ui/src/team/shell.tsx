import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { createInterfaceI18n, type InterfaceI18n, type InterfaceLanguage } from "@openrig/i18n";
import type { TeamOwnerRead, TeamQueueState, TeamRun } from "@openrig/daemon/team-control";
import { I18nextProvider, useTranslation } from "react-i18next";
import { Activity as ActivityIcon, Bot, ClipboardList, Folder, Home, Library, Settings, ShieldCheck } from "lucide-react";
import { version } from "../../package.json";
import { Card } from "../components/ui/card.js";
import { Button } from "../components/ui/button.js";
import { applySkin, readStoredSkin, SKINS, writeStoredSkin, type SkinId } from "../lib/theme.js";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion.js";
import { OwnerReadError, OwnerSessionProvider, useOwnerSession } from "../hooks/useOwnerSession.js";
import { useTeamRun } from "../hooks/useTeamRun.js";
import { RunStepper } from "./run-stepper.js";
import { Overview } from "./overview.js";
import "../skins/shuimo-danqing/skin.css";

export const INTERFACE_LANGUAGE_KEY = "openrig.interfaceLanguage";
const destinations = [
  ["overview", Home], ["tasks", ClipboardList], ["workspace", Folder], ["agents", Bot],
  ["decisions", ShieldCheck], ["logs", ActivityIcon], ["knowledge", Library], ["settings", Settings],
] as const;

export function SkinBackdrop({ skin }: { skin: SkinId }) {
  const video = useRef<HTMLVideoElement>(null);
  const reduced = usePrefersReducedMotion();
  useEffect(() => {
    if (!video.current) return;
    if (reduced) video.current.pause();
    else void video.current.play().catch(() => { /* A blocked autoplay leaves a decorative still frame. */ });
  }, [skin, reduced]);
  return skin === "shuimo-danqing" ? <div className="team-backdrop" aria-hidden="true">
    <video ref={video} src="/skins/shuimo-danqing/shuimo-danqing-loop.mp4"
      poster="/skins/shuimo-danqing/sm-paper-grain.webp" loop muted playsInline preload="metadata" />
  </div> : null;
}

function Pairing() {
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

function CurrentPlan({ run, read }: { run?: TeamRun; read?: TeamOwnerRead }) {
  const { t } = useTranslation();
  return <Card className="team-card team-current-plan" role="region" aria-label={t("web.plan")}>
    <h2>{t("web.plan")}</h2><code>{run?.binding.planRef ?? t("web.unknown")}</code>
    <dl className="team-detail-facts"><div><dt>{t("web.digest")}</dt><dd>{run ? <details><summary><code>{run.binding.planDigest.slice(0, 19)}…</code></summary><code>{run.binding.planDigest}</code></details> : t("web.unknown")}</dd></div>
      <div><dt>{t("web.binding")}</dt><dd>{run ? <details><summary><code>{run.bindingDigest.slice(0, 19)}…</code></summary><code>{run.bindingDigest}</code></details> : t("web.unknown")}</dd></div>
      <div><dt>{t("web.runState")}</dt><dd>{run ? t(`status.run.${run.state}`) : t("web.unknown")}</dd></div>
      <div><dt>{t("web.approvalTime")}</dt><dd>{t("value.unavailable")}</dd></div>
      <div><dt>{t("web.readiness")}</dt><dd>{t(`web.stageState.${read?.workflow.stages.find(stage => stage.stage === "plan-approved")?.state ?? "unavailable"}`)}</dd></div>
    </dl>
  </Card>;
}

function ManagedShell({ language }: { language: InterfaceI18n }) {
  const { t } = useTranslation();
  const { paired } = useOwnerSession();
  const searchParams = useSearch({ from: "/team" });
  const runId = searchParams.run ?? "";
  const pathname = useRouterState({ select: state => state.location.pathname });
  const section = pathname.split("/")[2] || "overview";
  const navigate = useNavigate();
  const data = useTeamRun(runId);
  const [runDraft, setRunDraft] = useState(runId);
  const [filter, setFilter] = useState<TeamQueueState | "all">("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("id");
  const [selectedTask, setSelectedTask] = useState<string>();
  const [detailTab, setDetailTab] = useState("details");
  const [evidenceTab, setEvidenceTab] = useState("logs");
  const mainRef = useRef<HTMLElement>(null);
  const paneScroll = useRef<Record<string, [number, number]>>({});
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    for (const pane of [main, ...main.querySelectorAll<HTMLElement>("[data-scroll-pane]")]) {
      const position = paneScroll.current[pane.dataset.scrollPane!];
      if (position) { pane.scrollLeft = position[0]; pane.scrollTop = position[1]; }
    }
    const viewport = `window-${section}`;
    const position = paneScroll.current[viewport];
    if (position) window.scrollTo(...position);
    const rememberViewport = () => { if (paired) paneScroll.current[viewport] = [window.scrollX, window.scrollY]; };
    window.addEventListener("scroll", rememberViewport);
    return () => window.removeEventListener("scroll", rememberViewport);
  }, [section, paired]);
  const [skin, setSkin] = useState(readStoredSkin);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(timer); }, []);
  useEffect(() => { setRunDraft(runId); }, [runId]);
  useEffect(() => { applySkin(skin); return () => applySkin("navy"); }, [skin]);
  const error = data.read.error ?? data.events.error ?? data.health.error;
  const readAt = runId ? Math.min(data.read.dataUpdatedAt, Date.parse(data.read.data?.generatedAt ?? "") || 0) : data.health.dataUpdatedAt;
  const age = readAt ? Math.max(0, Math.floor((now - readAt) / 1_000)) : null;
  const connection = !paired ? "web.pairRequired" : error instanceof OwnerReadError ? (error.status === 404 ? "web.notFound" : "web.error")
    : error instanceof TypeError ? "web.disconnected" : error ? "web.error" : age === null ? "web.loading" : now - readAt > 5_000 ? "web.stale" : "web.snapshot";
  const approvals = paired && !data.read.isError && now - readAt <= 5_000 ? data.read.data?.approvals : undefined;
  const pending = approvals?.filter(item => item.state === "pending");
  const healthAvailable = paired && !data.health.isError && now - data.health.dataUpdatedAt <= 5_000;
  const preferences = <div className="team-preferences">
    <label>{t("language.label")}<select value={language.language} onChange={e => void language.changeLanguage(e.target.value as InterfaceLanguage)}>
      <option value="zh-CN">{t("language.zh-CN")}</option><option value="en">{t("language.en")}</option></select></label>
    <label>{t("web.skin")}<select value={skin} onChange={e => { const next = e.target.value as SkinId; setSkin(next); writeStoredSkin(next); }}>
      {SKINS.map(id => <option key={id} value={id}>{t(`web.skin.${id}`)}</option>)}</select></label>
  </div>;
  const nav = (mobile = false) => <nav className={mobile ? "team-mobile-nav" : "team-nav"} aria-label={mobile ? t("web.overview") : t("web.title")}>
    {destinations.filter(([id]) => !mobile || ["overview", "tasks", "decisions", "logs", "settings"].includes(id)).map(([id, Icon]) =>
      id === "workspace" || id === "knowledge" ? <Button key={id} disabled variant="ghost" title={t("web.laterPage")}><Icon aria-hidden="true" /><span>{t(`web.${id}`)}</span></Button> :
        <Link key={id} to="/team/$section" params={{ section: id }} search={{ run: runId || undefined }} resetScroll={false} aria-current={section === id ? "page" : undefined}>
          <Icon aria-hidden="true" /><span>{t(`web.${id}`)}</span></Link>)}
  </nav>;
  return <div className="team-shell" lang={language.language} data-testid="team-shell">
    <SkinBackdrop skin={skin} />
    <header className="team-topbar"><div className="team-brand"><Bot aria-hidden="true" /><h1>{t("web.title")}</h1><code>v{version}</code></div>
      <div className="team-top-meta"><span>{t("web.environment")}: {t("web.unknown")}</span><time dateTime={new Date(now).toISOString()}>{new Date(now).toLocaleTimeString(language.language)}</time>
        <Link to="/team/$section" params={{ section: "decisions" }} search={{ run: runId || undefined }}>{t("web.pendingDecisions")}: {pending?.length ?? "?"}</Link></div>
      {preferences}
    </header>
    <aside className="team-rail">{nav()}<CurrentPlan run={data.read.data?.run} read={data.read.data} /></aside>
    <main ref={mainRef} data-scroll-pane={`main-${section}`} onScrollCapture={event => {
      const pane = event.target as HTMLElement;
      // The re-pair prompt may temporarily remove a pane's scrollable layout.
      if (paired && pane.dataset.scrollPane) paneScroll.current[pane.dataset.scrollPane] = [pane.scrollLeft, pane.scrollTop];
    }} className={`team-main${paired && runId && ["overview", "tasks"].includes(section) ? " team-main-overview" : ""}`}>
      <div className="team-connection" role="status"><strong>{t(connection)}</strong>{age !== null && <span>{age} {t("web.seconds")}</span>}<span>{t("web.heartbeat")}: {data.events.isSuccess && !data.events.isError && now - data.events.dataUpdatedAt <= 5_000 ? data.events.data.window.latestSeq : t("value.unavailable")}</span></div>
      {!paired && section !== "settings" && <Pairing />}
      <form className="team-run-picker" onSubmit={e => { e.preventDefault(); void navigate({ to: "/team/$section", params: { section }, search: { run: runDraft.trim() || undefined } }); }}>
        <label>{t("web.run")}<input value={runDraft} onChange={e => setRunDraft(e.target.value)} autoComplete="off" /></label><Button type="submit" variant="outline">{t("web.loadRun")}</Button>
      </form>
      {!runId && <div className="team-empty" role="status"><strong>{t("web.noRun")}</strong><p>{t("web.discovery")}</p></div>}
      {section === "settings" ? <Card className="team-card"><h2>{t("web.settings")}</h2>{preferences}<Pairing /></Card> : <>
        <RunStepper workflow={data.read.data?.workflow} />
        <Overview controlsAvailable={paired && !error && age !== null && now - readAt <= 5_000} refresh={() => data.read.refetch({ throwOnError: true })} section={section} run={data.read.data?.run} runId={runId} read={data.read.data} replay={data.events.data} selectedTask={selectedTask} onSelectTask={setSelectedTask} health={data.health.data}
          healthAvailable={healthAvailable} now={now} filter={filter} search={search} sort={sort} onFilter={setFilter} onSearch={setSearch} onSort={setSort}
          detailTab={detailTab} evidenceTab={evidenceTab} onDetailTab={setDetailTab} onEvidenceTab={setEvidenceTab} />
      </>}
    </main>
    {nav(true)}
  </div>;
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
