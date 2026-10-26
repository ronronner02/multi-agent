import type { TeamSystemHealth } from "@openrig/daemon/team-control";
import { useTranslation } from "react-i18next";
import { Card } from "../components/ui/card.js";
import { Button } from "../components/ui/button.js";

export function AgentStatus({ health, runId }: { health?: TeamSystemHealth; runId: string }) {
  const { t } = useTranslation();
  const attempts = Object.values(health?.latestAttempts ?? {}).filter(attempt => attempt.runId === runId);
  return <Card className="team-card" role="region" aria-label={t("web.agentStatus")}>
    <h2>{t("web.agentStatus")}</h2>
    <dl className="team-facts">{(["role", "model", "sessionState"] as const).map(key =>
      <div key={key}><dt>{t(`web.${key}`)}</dt><dd>{t("web.unknown")}</dd></div>)}</dl>
    <p className="team-muted">{t("web.pending")}</p>
    <h3>{t("web.observedAttempts")}</h3>
    {attempts.length ? <ul className="team-attempts">{attempts.map(attempt => <li key={attempt.attemptId}>
      <code>{attempt.worker ?? attempt.attemptId}</code><span>{attempt.client ?? t("web.unknown")}</span>
      <span>{attempt.state} · {attempt.checkedAt}</span><span>{attempt.reasonCode}</span>
    </li>)}</ul> : <p className="team-muted">{t("web.noAttempts")}</p>}
    <Button variant="outline" disabled>{t("web.openSession")}</Button>
    <p className="team-muted">{t("web.nativeTarget")}</p>
  </Card>;
}
