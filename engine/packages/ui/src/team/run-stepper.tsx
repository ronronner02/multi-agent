import { TEAM_WORKFLOW_STAGES, type TeamRunStageView } from "../../../daemon/dist/contracts/team-control.js";
import { useTranslation } from "react-i18next";
import { Card } from "../components/ui/card.js";

export function RunStepper({ workflow }: { workflow?: TeamRunStageView }) {
  const { t } = useTranslation();
  const labels = ["setup", "plan", "assignments", "execution", "review", "integration", "delivery"] as const;
  return <Card className="team-card team-stepper" role="region" aria-label={t("web.stepper")}>
    <div className="team-card-heading"><h2>{t("web.stepper")}</h2></div>
    <ol>{TEAM_WORKFLOW_STAGES.map((stage, index) => {
      const evidence = workflow?.stages.find(item => item.stage === stage);
      const state = evidence?.state ?? "unavailable";
      return <li key={stage} data-state={state} aria-current={workflow?.current === stage ? "step" : undefined} title={evidence?.evidence}>
        <span className="team-stage-number">{index}</span><span>{t(`web.stage.${labels[index]!}`)}<small>{t(`web.stageState.${state}`)}</small></span>
      </li>;
    })}</ol>
    <p className="team-muted">{t("web.stageEvidence")}</p>
  </Card>;
}
