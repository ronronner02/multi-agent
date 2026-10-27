import type { TeamOwnerRead, TeamReadModel } from "@openrig/daemon/team-control";
import { useTranslation } from "react-i18next";
import { Card } from "../components/ui/card.js";

export function Activity({ read, replay }: { read?: TeamOwnerRead; replay?: ReturnType<TeamReadModel["replay"]> }) {
  const { t } = useTranslation();
  return <Card className="team-card" role="region" aria-label={t("web.activity")}>
    <h2>{t("web.activity")}</h2>
    {replay?.gap && <p role="status">{t("web.replayGap")}</p>}
    {!read ? <p>{t("value.unavailable")}</p> : <>
      <time>{read.generatedAt}</time>
      {read.logs.slice(-10).map((log, index) => <p key={`log-${index}`}><time>{log.ts}</time> {log.taskId} {log.body}{log.truncated && <small>{t("web.truncated")}</small>}</p>)}
      {replay?.events.map(event => <div key={event.seq} data-event-seq={event.seq}>
        <time>{event.createdAt}</time> <code>{event.taskId ?? event.runId}</code><p>{event.action ?? event.type}</p><pre>{event.body}</pre>
        {event.truncated && <small>{t("web.truncated")}</small>}
      </div>)}
      {!read.logs.length && !replay?.events.length && <p>{t("web.noEvents")}</p>}
    </>}
  </Card>;
}
