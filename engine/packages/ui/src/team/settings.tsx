import { useTranslation } from "react-i18next";
import type { InterfaceI18n } from "@openrig/i18n";
import { useOwnerSession } from "../hooks/useOwnerSession.js";

/**
 * U10 — the one screen the overflow menu opens.
 *
 * The language control lives in the top bar, so this pane keeps only what the owner cannot see
 * elsewhere: how the browser is connected to the daemon, and the way to revoke it.
 */
export function SettingsScreen({ language, connection, isolation, address, onClose }: {
  language: InterfaceI18n; connection: string; isolation: "none" | "hardened" | null; address: string; onClose: () => void;
}) {
  const { t } = useTranslation();
  const { paired, revoke } = useOwnerSession();
  return <main className="page page-narrow">
    <div className="page-head">
      <h1 className="display">{t("team.settings.title")}</h1>
      <button className="btn btn-quiet" onClick={onClose}>{t("team.settings.close")}</button>
    </div>
    <dl className="team-facts" style={{ display: "grid", gap: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderTop: "1px solid var(--line)" }}>
        <dt className="muted" style={{ fontSize: 13 }}>{t("team.settings.language")}</dt>
        <dd style={{ margin: 0, fontSize: 13 }}>{language.language === "zh-CN" ? "中文" : "English"}</dd>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderTop: "1px solid var(--line-soft)" }}>
        <dt className="muted" style={{ fontSize: 13 }}>{t("team.settings.connection")}</dt>
        <dd style={{ margin: 0, fontSize: 13 }}>{t(connection as "shell.connected")}</dd>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderTop: "1px solid var(--line-soft)" }}>
        <dt className="muted" style={{ fontSize: 13 }}>{t("settings.runtime.isolation")}</dt>
        <dd style={{ margin: 0, fontSize: 13 }} className="mono">{isolation ?? "—"}</dd>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderTop: "1px solid var(--line-soft)" }}>
        <dt className="muted" style={{ fontSize: 13 }}>{t("shell.remoteMonitor")}</dt>
        <dd style={{ margin: 0, fontSize: 13 }} className="mono">{address}</dd>
      </div>
    </dl>
    {paired && <div style={{ marginTop: 20 }}>
      <button className="btn btn-outline" onClick={() => void revoke()}>{t("team.settings.revoke")}</button>
    </div>}
  </main>;
}