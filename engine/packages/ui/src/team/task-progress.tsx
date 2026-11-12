import { useTranslation } from "react-i18next";
import type { TeamReviewView } from "@multi-agent/daemon/team-control";

export function TaskProgress({ task }: { task: TeamReviewView }) {
  const { t } = useTranslation();
  const { verified, total } = task.criteria;
  if (verified === null || total === null) return <span className="ui-task-progress ui-muted">{t("tasks.progressUnknown")}</span>;
  const label = t("tasks.criteriaOf", { verified, total });
  return <span className="ui-task-progress"><span>{label}</span>
    {total > 0 && <progress value={verified} max={total} aria-label={label} />}
  </span>;
}
