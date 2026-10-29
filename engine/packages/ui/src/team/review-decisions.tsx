import type { TeamReviewView } from "@openrig/daemon/team-control";
import { useTranslation } from "react-i18next";
import { Card } from "../components/ui/card.js";

export function ReviewDecisions({ tasks }: { tasks?: TeamReviewView[] }) {
  const { t } = useTranslation();
  return <Card className="team-card" role="region" aria-label={t("web.reviewRecord")}><h2>{t("web.reviewRecord")}</h2>
    {!tasks?.length ? <p>{t("value.unavailable")}</p> : tasks.map(task => <section key={task.qitemId}>
      <h3><code>{task.taskId}</code></h3><p>{t("web.candidate")}: <code>{task.currentCandidateDigest ?? t("value.unavailable")}</code></p>
      {task.reviewAvailable ? <p>{t("web.reviewRounds")}: {task.rounds} · {t("web.openP0P1")}: {task.openP0P1}</p> : <p>{t("value.unavailable")}</p>}
    </section>)}
  </Card>;
}
