import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { OwnerReadError, useOwnerSession } from "../hooks/useOwnerSession.js";

interface AgentStatus { signedIn: boolean; login: string | null; host: string; sameAsOwner: boolean }
interface LoginState { state: "idle" | "pending" | "done" | "failed"; code?: string; url?: string }
const statusKey = ["github", "agent", "status"], loginKey = ["github", "agent", "login"];

/** Plan R16 — the team's own GitHub account, signed in apart from the owner's. */
export function AgentAccount() {
  const { t } = useTranslation(), { paired, request } = useOwnerSession(), cache = useQueryClient();
  const status = useQuery({ queryKey: statusKey, enabled: paired, retry: false,
    queryFn: ({ signal }) => request<AgentStatus>("/github/agent/status", { signal }) });
  const flow = useQuery({ queryKey: loginKey, enabled: paired && status.data?.signedIn === false, retry: false,
    queryFn: ({ signal }) => request<LoginState>("/github/agent/login", { signal }),
    refetchInterval: query => {
      if (query.state.data?.state === "done") void cache.invalidateQueries({ queryKey: statusKey });
      return query.state.data?.state === "pending" ? 1_500 : false;
    } });
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<string | null>(null);
  const act = async (path: string, key: string[]) => {
    setBusy(true); setFailure(null);
    try { cache.setQueryData(key, await request(path, { method: "POST" })); await cache.invalidateQueries({ queryKey: statusKey }); }
    catch (error) { setFailure(error instanceof OwnerReadError ? error.code : "generic"); }
    finally { setBusy(false); }
  };
  const pending = flow.data?.state === "pending";
  return <section className="plate ui-settings-panel" aria-label={t("settings.agentAccount")}>
    <h2>{t("settings.agentAccount")}</h2>
    {status.isError ? <p role="alert">{t("github.statusFailed")}</p>
      : <p className="ui-account"><strong>{status.data?.login ?? "—"}</strong><span className="muted">{status.data?.host}</span></p>}
    {status.data?.sameAsOwner && <p role="alert">{t("settings.agentSameAsOwner")}</p>}
    {pending && <div className="ui-device-flow" role="status">
      <span>{t("github.deviceCode")}</span><code>{flow.data?.code}</code>
      {flow.data?.url === "https://github.com/login/device" && <a className="btn btn-primary" href={flow.data.url} target="_blank" rel="noopener noreferrer">
        {t("github.openDevice")}<ExternalLink aria-hidden="true" /></a>}
    </div>}
    {status.data && !status.data.signedIn && !pending && <button className="btn btn-primary" disabled={busy}
      onClick={() => void act("/github/agent/login", loginKey)}>{t("settings.agentSignIn")}</button>}
    {status.data?.signedIn && <button className="btn btn-outline" disabled={busy}
      onClick={() => void act("/github/agent/logout", statusKey)}>{t("settings.signOut")}</button>}
    {failure && <p role="alert">{t(failure === "github_cli_missing" ? "github.missing" : "github.failed")}</p>}
  </section>;
}
