import { TEAM_HEALTH_LIGHTS, type TeamRun, type TeamSystemHealth } from "@openrig/daemon/team-control";
import { useTranslation } from "react-i18next";
import { Card } from "../components/ui/card.js";
import { getHealthStatusClass } from "../lib/status-colors.js";

export function SystemStatus({ run, health, available, now }: {
  run?: TeamRun; health?: TeamSystemHealth; available: boolean; now: number;
}) {
  const { t } = useTranslation();
  return <Card className="team-card" role="region" aria-label={t("web.system")}>
    <h2>{t("web.system")}</h2>
    <dl className="team-facts">
      <div><dt>{t("web.repository")}</dt><dd><code>{run?.binding.repository.identity ?? t("web.unknown")}</code></dd></div>
      {(["branch", "environment", "ownerClients"] as const).map(key => <div key={key}>
        <dt>{t(`web.${key}`)}</dt><dd>{t("web.pending")}</dd></div>)}
      {TEAM_HEALTH_LIGHTS.map(name => {
        const light = health?.lights[name];
        const fresh = !!light && Number.isFinite(Date.parse(light.checkedAt)) && now - Date.parse(light.checkedAt) <= 5_000;
        const state = available && fresh ? light.state : "unknown";
        return <div key={name} data-health-light={name}>
          <dt>{t(`web.health.${name}`)}</dt><dd className={getHealthStatusClass(state)}>
            <span className="team-health-dot" aria-hidden="true" />{t(`web.health.${state}`)}
            {light?.reason && <small>{light.reason}</small>}
            {light?.evidenceRef && <code>{light.evidenceRef}</code>}
          </dd>
        </div>;
      })}
    </dl>
    <p className="team-muted">{t("web.healthAge")}: <time>{health?.checkedAt ?? t("web.unknown")}</time></p>
  </Card>;
}
