import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Monitor, Moon, Sun } from "lucide-react";
import type { InterfaceI18n, InterfaceLanguage } from "@openrig/i18n";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { OwnerReadError, useOwnerSession } from "../hooks/useOwnerSession.js";
import { PageHeader, Pairing } from "./shell.js";
import { TEAM_THEME_PREFERENCES, type TeamThemePreference } from "./theme.js";

/**
 * Slice C — Settings.
 *
 * A left section list over the sections that have real backing. General, Agents, Providers and
 * Workspace have no store behind them in this client, so they are not listed at all: an empty
 * panel would claim a settings surface that does not exist.
 *
 * Appearance and Sessions are the two sections a reader can act on; Runtime and Plan report
 * facts the daemon already decided, and neither offers a control it cannot honour.
 */

export const SETTINGS_SECTIONS = ["appearance", "sessions", "runtime", "plan"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

const DASH = "—";

/** One paired browser session as `/owner-session/sessions` publishes it. */
export interface OwnerSessionRow {
  id: string;
  origin: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
}

function stamp(ms: number, locale: string): string {
  if (!Number.isFinite(ms) || ms <= 0) return DASH;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? DASH : date.toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });
}

/** One icon per theme option, so the three choices read at a glance rather than by label alone. */
const THEME_ICONS = { dark: Moon, light: Sun, system: Monitor } as const;

function Appearance({ language, theme, onTheme }: {
  language: InterfaceI18n; theme: TeamThemePreference; onTheme: (theme: TeamThemePreference) => void;
}) {
  const { t } = useTranslation();
  return <Card className="ui-panel" role="region" aria-label={t("settings.appearance")}>
    <h2>{t("settings.theme")}</h2>
    <p className="team-muted">{t("settings.themeHelp")}</p>
    <div className="ui-themes" role="radiogroup" aria-label={t("settings.theme")}>
      {TEAM_THEME_PREFERENCES.map(value => {
        const Icon = THEME_ICONS[value];
        return <button key={value} type="button" role="radio" aria-checked={theme === value}
          className="ui-theme-option" data-theme-option={value} onClick={() => onTheme(value)}>
          <Icon aria-hidden="true" />
          <span className="ui-radio" aria-hidden="true" data-checked={theme === value} />
          <span>{t(`settings.theme.${value}`)}</span>
        </button>;
      })}
    </div>
    <div className="ui-field">
      <label>{t("language.label")}
        <select value={language.language} onChange={event => void language.changeLanguage(event.target.value as InterfaceLanguage)}>
          <option value="zh-CN">{t("language.zh-CN")}</option><option value="en">{t("language.en")}</option>
        </select>
      </label>
    </div>
  </Card>;
}

function Sessions() {
  const { t, i18n } = useTranslation();
  const session = useOwnerSession();
  const cache = useQueryClient();
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const query = useQuery({ queryKey: ["team", "owner-sessions"], enabled: session.paired, retry: false,
    queryFn: ({ signal }) => session.request<{ sessions: OwnerSessionRow[] }>("/owner-session/sessions", { signal }) });
  const rows = query.data?.sessions ?? [];
  const revoke = async (id: string) => {
    setBusy(true); setFailed(null);
    try {
      await session.request(`/owner-session/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      await cache.invalidateQueries({ queryKey: ["team", "owner-sessions"] });
    } catch { setFailed(t("settings.sessions.failed")); } finally { setBusy(false); }
  };
  return <>
    <Card className="ui-panel" role="region" aria-label={t("settings.sessions")}>
      <h2>{t("settings.sessions")}</h2>
      <p className="team-muted">{t("settings.sessions.help")}</p>
      {!session.paired ? <p role="status">{t("web.pairRequired")}</p>
        : query.isError ? <p role="alert">{t("settings.sessions.unavailable")}</p>
        : rows.length === 0 ? <p className="team-muted">{query.isLoading ? t("web.loading") : t("settings.sessions.none")}</p>
        : <ul className="ui-sessions">{rows.map(row => {
          const revoked = row.revoked_at !== null;
          return <li key={row.id} data-session={row.id} data-revoked={revoked}>
            <div>
              <strong>{row.origin}</strong>
              <small>{t("settings.sessions.lastSeen")} {stamp(row.last_seen_at, i18n.language)}</small>
            </div>
            <span className="ui-state" data-state={revoked ? "stopped" : "done"}>
              {t(revoked ? "settings.sessions.revoked" : "settings.sessions.active")}</span>
            <Button variant="outline" aria-label={`${t("settings.sessions.revokeSession")} ${row.origin}`}
              disabled={busy || revoked} onClick={() => void revoke(row.id)}>
              {t("settings.sessions.revoke")}</Button>
          </li>;
        })}</ul>}
      {failed && <p role="alert">{failed}</p>}
    </Card>
    <Card className="ui-panel" role="region" aria-label={t("web.pair")}>
      <h2>{t("web.pair")}</h2>
      <Pairing />
    </Card>
  </>;
}

function Runtime({ connection, isolation, address }: {
  connection: string; isolation: "none" | "hardened" | null; address: string;
}) {
  const { t } = useTranslation();
  return <Card className="ui-panel" role="region" aria-label={t("settings.runtime")}>
    <h2>{t("settings.runtime")}</h2>
    <dl className="ui-facts">
      <div><dt>{t("settings.runtime.connection")}</dt>
        <dd data-runtime="connection"><span className="ui-dot" data-state={connection === "shell.connected" ? "ok" : "unknown"} aria-hidden="true" />
          {t(connection as "shell.connected")}</dd></div>
      <div><dt>{t("settings.runtime.isolation")}</dt>
        <dd data-runtime="isolation"><code>{isolation === null ? t("web.unknown") : t(`settings.runtime.isolation.${isolation}`)}</code>
          <small>{isolation === null ? t("settings.runtime.isolationUnknown") : t(`settings.runtime.isolationHelp.${isolation}`)}</small></dd></div>
      <div><dt>{t("settings.runtime.address")}</dt><dd data-runtime="address"><code>{address || DASH}</code></dd></div>
    </dl>
  </Card>;
}

export function SettingsScreen({ language, theme, onTheme, connection, isolation, address, planRef }: {
  language: InterfaceI18n; theme: TeamThemePreference; onTheme: (theme: TeamThemePreference) => void;
  connection: string; isolation: "none" | "hardened" | null; address: string; planRef: string | undefined;
}) {
  const { t } = useTranslation();
  const [section, setSection] = useState<SettingsSection>("appearance");
  return <div className="ui-settings">
    <PageHeader title={t("settings.title")} />
    <div className="ui-settings-body">
      <nav className="ui-sections" aria-label={t("settings.sections")}>
        {SETTINGS_SECTIONS.map(id => <button key={id} type="button" aria-pressed={section === id}
          onClick={() => setSection(id)}>{t(`settings.section.${id}`)}</button>)}
      </nav>
      <div className="ui-settings-pane">
        {section === "appearance" && <Appearance language={language} theme={theme} onTheme={onTheme} />}
        {section === "sessions" && <Sessions />}
        {section === "runtime" && <Runtime connection={connection} isolation={isolation} address={address} />}
        {section === "plan" && <Card className="ui-panel" role="region" aria-label={t("settings.plan")}>
          <h2>{t("settings.plan")}</h2>
          <p className="team-muted">{planRef ?? t("web.noRun")}</p>
        </Card>}
      </div>
    </div>
  </div>;
}
