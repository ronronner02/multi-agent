import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TeamOwnerRead } from "@openrig/daemon/team-control";
import { Card } from "../components/ui/card.js";
import { PageHeader } from "./shell.js";
import { CostChart, TokenChart } from "./analytics-charts.js";
import {
  ANALYTICS_RANGES, compactCount, costByModel, duration, summary, tokenSeries, utilization,
  type AnalyticsRange,
} from "./analytics-model.js";

/**
 * Slice C — Analytics.
 *
 * One run's observed usage: what the attempts recorded, in the range the reader picks. Every
 * figure is read from the read model, and anything the producers never observed stays an em
 * dash. The single quiet line under the heading names what is not recorded, so a reader can
 * tell an empty panel from a missing measurement.
 */

const DASH = "—";

function percent(value: number | null): string {
  return value === null ? DASH : `${Math.round(value * 100)}%`;
}

function usd(value: number | null): string {
  return value === null ? DASH : `$${value.toFixed(2)}`;
}

export function AnalyticsScreen({ read, runId }: { read?: TeamOwnerRead; runId: string }) {
  const { t } = useTranslation();
  const [range, setRange] = useState<AnalyticsRange>("run");
  const now = Date.now();
  const figures = read ? summary(read) : undefined;
  const cells = [
    { key: "analytics.tokens", value: figures?.tokens == null ? DASH : compactCount(figures.tokens) },
    { key: "analytics.cost", value: usd(figures?.costUsd ?? null) },
    { key: "analytics.median", value: duration(figures?.medianTaskMs ?? null) },
    { key: "analytics.success", value: percent(figures?.successRate ?? null) },
    { key: "analytics.retry", value: percent(figures?.retryRate ?? null) },
  ] as const;
  const series = read ? tokenSeries(read, range, now) : null;
  const costs = read ? costByModel(read) : null;
  const agents = read ? utilization(read) : [];

  return <div className="ui-analytics">
    <PageHeader title={t("nav.analytics")} subtitle={runId || undefined} actions={
      <label className="ui-range">{t("analytics.range")}
        <select value={range} onChange={event => setRange(event.target.value as AnalyticsRange)}>
          {ANALYTICS_RANGES.map(value => <option key={value} value={value}>{t(`analytics.range.${value}`)}</option>)}
        </select>
      </label>
    } />
    <Card className="ui-summary" role="region" aria-label={t("analytics.summary")}>
      <dl>{cells.map(cell => <div key={cell.key} data-summary={cell.key}>
        <dt>{t(cell.key)}</dt><dd>{cell.value}</dd>
      </div>)}</dl>
    </Card>
    <p className="team-muted ui-analytics-note">{t("analytics.notRecorded")}</p>
    <div className="ui-analytics-grid">
      <Card className="ui-panel" role="region" aria-label={t("analytics.tokensOverTime")}>
        <h2>{t("analytics.tokensOverTime")}</h2>
        {!read ? <p className="team-muted">{t("value.unavailable")}</p>
          : !series ? <p className="team-muted">{t("analytics.noSeries")}</p>
          : <TokenChart series={series} />}
        <p className="team-muted ui-legend"><span className="ui-legend-key" aria-hidden="true" />{t("analytics.tokensLegend")}</p>
      </Card>
      <Card className="ui-panel" role="region" aria-label={t("analytics.costByModel")}>
        <h2>{t("analytics.costByModel")}</h2>
        {!read ? <p className="team-muted">{t("value.unavailable")}</p>
          : !costs ? <p className="team-muted">{t("analytics.noCost")}</p>
          : <CostChart rows={costs.map(row => ({ key: row.model, label: t(`analytics.provider.${row.model}` as "analytics.provider.claude"),
            costUsd: row.costUsd }))} />}
      </Card>
    </div>
    <Card className="ui-panel" role="region" aria-label={t("analytics.utilization")}>
      <h2>{t("analytics.utilization")}</h2>
      {!read ? <p className="team-muted">{t("value.unavailable")}</p>
        : <table className="ui-table">
          <thead><tr>{(["analytics.colAgent", "analytics.colRuntime", "analytics.colActive", "analytics.colTasks",
            "analytics.colRetries", "analytics.colCost"] as const).map(key => <th key={key} scope="col">{t(key)}</th>)}</tr></thead>
          <tbody>{agents.map(agent => <tr key={agent.role} data-agent={agent.role}>
            <td>{t(`role.${agent.role}`)}</td>
            <td className="team-muted">{agent.providers.length ? agent.providers.join(" · ") : DASH}</td>
            <td>{duration(agent.activeMs)}</td>
            <td>{agent.attempts === 0 ? DASH : agent.tasks}</td>
            <td>{agent.attempts === 0 ? DASH : agent.retries}</td>
            <td>{usd(agent.costUsd)}</td>
          </tr>)}</tbody>
        </table>}
    </Card>
  </div>;
}
