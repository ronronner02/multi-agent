import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { InterfaceI18n } from "@multi-agent/i18n";
import { GitBranch, ExternalLink } from "lucide-react";
import { OwnerReadError, useOwnerSession } from "../hooks/useOwnerSession.js";
import { Background } from "./background.js";
import { TEAM_THEME_PREFERENCES, type useThemePreference } from "./theme.js";

export interface GithubStatus { signedIn: boolean; login: string | null; host: string }
interface LoginState { state: "idle" | "pending" | "done" | "failed"; code?: string; url?: string }
export const githubStatusKey = ["team", "github", "status"] as const;
const loginKey = ["team", "github", "login"] as const;

export function useGithubStatus() {
  const { paired, request } = useOwnerSession();
  return useQuery({ queryKey: githubStatusKey, enabled: paired, retry: false, refetchInterval: 10_000,
    queryFn: ({ signal }) => request<GithubStatus>("/github/status", { signal }) });
}

export function EntryFrame({ language, onLanguage, appearance, backgroundMotion, children }: {
  language: InterfaceI18n; onLanguage: (next: "en" | "zh-CN") => void;
  appearance: ReturnType<typeof useThemePreference>; backgroundMotion: boolean; children: ReactNode;
}) {
  const { t } = useTranslation();
  return <div className="team-shell ui-entry" data-ui-theme={appearance.theme} lang={language.language}>
    <Background motion={backgroundMotion} />
    <header className="ui-entry-header"><strong>{t("shell.appName")}</strong>
      <div className="ui-entry-preferences">
        <label>{t("team.settings.language")}<select value={language.language} onChange={event => onLanguage(event.target.value as "en" | "zh-CN")}>
          <option value="en">English</option><option value="zh-CN">中文</option>
        </select></label>
        <label>{t("shell.appearance")}<select value={appearance.preference} onChange={event => appearance.setPreference(event.target.value as "dark" | "light" | "system")}>
          {TEAM_THEME_PREFERENCES.map(theme => <option key={theme} value={theme}>{t(`settings.theme.${theme}`)}</option>)}
        </select></label>
      </div>
    </header>
    <main className="ui-entry-main">{children}</main>
  </div>;
}

/** The application subtree is not mounted until a fresh account check succeeds. */
export function GithubGate({ children, frame }: { children: ReactNode; frame: (content: ReactNode) => ReactNode }) {
  const { t } = useTranslation();
  const { request } = useOwnerSession();
  const cache = useQueryClient();
  const status = useGithubStatus();
  const [verified, setVerified] = useState(false);
  useEffect(() => {
    if (status.isFetchedAfterMount && !status.isError) setVerified(status.data?.signedIn === true);
  }, [status.isFetchedAfterMount, status.isError, status.data?.signedIn]);
  const signedIn = status.isFetchedAfterMount && !status.isError && status.data?.signedIn;
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const flow = useQuery({ queryKey: loginKey, retry: false,
    enabled: status.isFetchedAfterMount && !status.isError && status.data?.signedIn === false,
    queryFn: ({ signal }) => request<LoginState>("/github/login", { signal }),
    refetchInterval: query => query.state.data?.state === "pending" ? 1_500 : false });
  useEffect(() => {
    if (flow.data?.state === "done") void cache.invalidateQueries({ queryKey: githubStatusKey });
  }, [flow.data?.state, cache]);
  const pending = flow.data?.state === "pending";
  const failed = startError !== null || flow.isError || flow.data?.state === "failed";
  const missing = startError === "github_cli_missing"
    || (status.error instanceof OwnerReadError && status.error.code === "github_cli_missing");
  const start = async () => {
    setStarting(true); setStartError(null);
    try {
      const next = await request<LoginState>("/github/login", { method: "POST" });
      cache.setQueryData(loginKey, next);
    } catch (error) { setStartError(error instanceof OwnerReadError ? error.code : "github_login_failed"); }
    finally { setStarting(false); }
  };
  return <>
    {(signedIn || status.isError && verified) && <div hidden={!signedIn} style={{ height: "100%" }}>{children}</div>}
    {!signedIn && frame(<section className="plate ui-github-gate" aria-label={t("github.title")}>
    <GitBranch className="ui-gate-icon" aria-hidden="true" />
    <h1 className="display">{t("github.title")}</h1>
    <p className="muted">{t("github.description")}</p>
    {!status.isFetchedAfterMount && !status.isError ? <p role="status">{t("web.loading")}</p>
      : status.isError ? <><p role="alert">{t(missing ? "github.missing" : "github.statusFailed")}</p>
        <button className="btn btn-primary" onClick={() => void status.refetch()}>{t("github.retry")}</button></>
      : <>
        {pending && <div className="ui-device-flow" role="status">
          <span>{t("github.deviceCode")}</span><code>{flow.data?.code}</code>
          {flow.data?.url === "https://github.com/login/device" && <a className="btn btn-primary" href={flow.data.url} target="_blank" rel="noopener noreferrer">
            {t("github.openDevice")}<ExternalLink aria-hidden="true" /></a>}
          <small>{t("github.waiting")}</small>
        </div>}
        {failed && <p role="alert">{t(missing ? "github.missing" : "github.failed")}</p>}
        {!pending && <button className="btn btn-primary" disabled={starting} onClick={() => void start()}>
          {t(starting ? "web.loading" : failed ? "github.retry" : "github.title")}</button>}
      </>}
  </section>)}
  </>;
}
