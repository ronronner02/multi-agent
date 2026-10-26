import { useTranslation } from "react-i18next";
import { Card } from "../components/ui/card.js";

export function Activity() {
  const { t } = useTranslation();
  return <Card className="team-card" role="region" aria-label={t("web.activity")}>
    <h2>{t("web.activity")}</h2><p className="team-muted">{t("web.pending")}</p><p>{t("web.activityPending")}</p>
  </Card>;
}
