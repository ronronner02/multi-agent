import { useTranslation } from "react-i18next";
import { Card } from "../components/ui/card.js";

export function RunStepper() {
  const { t } = useTranslation();
  const stages = ["setup", "plan", "assignments", "execution", "review", "integration", "delivery"] as const;
  return <Card className="team-card team-stepper" role="region" aria-label={t("web.stepper")}>
    <div className="team-card-heading"><h2>{t("web.stepper")}</h2><span className="team-muted">{t("web.pending")}</span></div>
    <ol>{stages.map((stage, index) => <li key={stage} data-state="unknown">
      <span className="team-stage-number">{index}</span><span>{t(`web.stage.${stage}`)}</span>
    </li>)}</ol>
    <p className="team-muted">{t("web.stageEvidence")}</p>
  </Card>;
}
