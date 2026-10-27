import type { TeamAttemptView, TeamSystemHealth } from "@openrig/daemon/team-control";
import { useTranslation } from "react-i18next";
import { Card } from "../components/ui/card.js";
import { Button } from "../components/ui/button.js";

export function AgentStatus({ health, runId, attempts: sessions }: { health?: TeamSystemHealth; runId: string; attempts?: TeamAttemptView[] }) {
  const { t } = useTranslation();
  const attempts = Object.values(health?.latestAttempts ?? {}).filter(attempt => attempt.runId === runId);
  return <Card className="team-card" role="region" aria-label={t("web.agentStatus")}>
    <h2>{t("web.agentStatus")}</h2>
    {sessions === undefined ? <p>{t("value.unavailable")}</p> : !sessions.length ? <p>{t("web.noAttempts")}</p> :
      sessions.map(attempt => <dl className="team-facts" key={attempt.attemptId}>
        <div><dt>{t("web.attempt")}</dt><dd><code>{attempt.attemptId}</code></dd></div>
        <div><dt>{t("web.taskId")}</dt><dd>{attempt.taskId ?? t("value.unavailable")}</dd></div>
        <div><dt>{t("web.role")}</dt><dd>{t(`role.${attempt.role}`)}</dd></div>
        <div><dt>{t("web.provider")}</dt><dd>{attempt.provider}</dd></div>
        <div><dt>{t("web.model")}</dt><dd>{t("value.unavailable")}</dd></div>
        <div><dt>{t("web.sessionState")}</dt><dd>{t(`status.attempt.${attempt.state}`)}<small>{attempt.unknownReason}</small></dd></div>
        <div><dt>{t("web.session")}</dt><dd><code>{attempt.session ?? t("value.unavailable")}</code></dd></div>
      </dl>)}
    <h3>{t("web.observedAttempts")}</h3>
    {attempts.length ? <ul className="team-attempts">{attempts.map(attempt => <li key={attempt.attemptId}>
      <code>{attempt.worker ?? attempt.attemptId}</code><span>{attempt.client ?? t("web.unknown")}</span>
      <span>{attempt.state} · {attempt.checkedAt}</span><span>{attempt.reasonCode}</span>
    </li>)}</ul> : <p className="team-muted">{t("web.noAttempts")}</p>}
    <Button variant="outline" disabled>{t("web.openSession")}</Button>
    <p className="team-muted">{t("web.nativeTarget")}</p>
  </Card>;
}
