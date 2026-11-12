import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TeamAnalytics, TeamSeatView } from "@multi-agent/daemon/team-control";
import { useOwnerSession } from "../hooks/useOwnerSession.js";
import { TokenChart, ModelTokenChart } from "./analytics-charts.js";
import { ANALYTICS_RANGES, cachedTokens, count, duration, percent, type AnalyticsRange } from "./analytics-model.js";
import { namedSeat } from "./display.js";

export function AnalyticsScreen({ teamId, seats = [] }: { teamId?: string; seats?: readonly TeamSeatView[] }) {
  const { t } = useTranslation();
  const { paired, request } = useOwnerSession();
  const [range, setRange] = useState<AnalyticsRange>(7);
  const query = useQuery({ queryKey: ["team", "analytics", teamId ?? null, range], enabled: paired, retry: false, refetchInterval: 5_000,
    queryFn: async ({ signal }) => (await request<{ analytics: TeamAnalytics }>("/analytics?" + new URLSearchParams({
      days: String(range), ...(teamId ? { team: teamId } : {}),
    }), { signal })).analytics });
  const data = query.isError ? undefined : query.data;
  const totals = data?.totals;
  const cells = [
    { key: "analytics.tokens", value: count(totals?.tokens) },
    { key: "analytics.inputNative", value: count(totals?.inputTokens) },
    { key: "analytics.cachedNative", value: count(cachedTokens(totals)) },
    { key: "analytics.outputNative", value: count(totals?.outputTokens) },
  ] as const;
  return <div className="page ui-analytics">
    <div className="page-head"><div><h1 className="display">{t("nav.analytics")}</h1><p className="muted">{t("analytics.population")}</p></div>
      <label className="ui-range">{t("analytics.range")}<select value={range} onChange={event => setRange(Number(event.target.value) as AnalyticsRange)}>
        {ANALYTICS_RANGES.map(days => <option key={days} value={days}>{t(days === 7 ? "analytics.range.7d" : "analytics.range.30d")}</option>)}
      </select></label>
    </div>
    {query.isError && <p role="alert">{t("analytics.readFailed")}</p>}
    <section className="plate ui-summary" aria-label={t("analytics.summary")}>
      <dl>{cells.map(cell => <div key={cell.key}><dt>{t(cell.key)}</dt><dd>{cell.value}</dd></div>)}</dl>
      {totals && (totals.measuredAttempts < totals.attempts || totals.partialAttempts > 0) && <p className="muted">{t("analytics.partial", {
        measured: totals.measuredAttempts, total: totals.attempts,
      })}</p>}
    </section>
    <div className="ui-analytics-grid">
      <section className="plate" aria-label={t("analytics.tokensOverTime")}><h2>{t("analytics.tokensOverTime")}</h2>
        {data?.byDay.some(day => day.tokens !== null) ? <TokenChart series={data.byDay} /> : <p className="muted">{t("analytics.noSeries")}</p>}
      </section>
      <section className="plate" aria-label={t("analytics.tokensByModel")}><h2>{t("analytics.tokensByModel")}</h2>
        {data?.byModel.length ? <ModelTokenChart rows={data.byModel.map(row => ({ label: row.model ?? t("analytics.unknownModel"), tokens: row.tokens }))} />
          : <p className="muted">{t("analytics.noSeries")}</p>}
      </section>
    </div>
    <section className="plate ui-summary" aria-label={t("analytics.outcomes")}><dl>
      <div><dt>{t("analytics.colActive")}</dt><dd>{totals ? duration(totals.activeMs) : "—"}</dd></div>
      <div><dt>{t("analytics.medianAttempt")}</dt><dd>{duration(totals?.medianDurationMs ?? null)}</dd></div>
      <div><dt>{t("analytics.success")}</dt><dd>{percent(totals?.successRate ?? null)}</dd>
        {totals && <small className="muted">{t("analytics.knownOutcomes", { count: totals.outcomeAttempts })}</small>}</div>
      <div><dt>{t("analytics.retry")}</dt><dd>{percent(totals?.retryRate ?? null)}</dd>
        {totals && <small className="muted">{t("analytics.attemptCount", { count: totals.attempts })}</small>}</div>
    </dl></section>
    <section className="plate" aria-label={t("analytics.utilization")}><h2>{t("analytics.utilization")}</h2>
      <p className="muted">{t("analytics.activeShare")}</p>
      {!data?.bySeat.length ? <p className="muted">{t("value.unavailable")}</p> : <div className="ui-table-scroll"><table className="ui-usage-table">
        <thead><tr>{["analytics.colAgent", "analytics.colActive", "analytics.share", "analytics.attempts", "analytics.tokens"].map(key =>
          <th key={key} scope="col">{t(key as "analytics.tokens")}</th>)}</tr></thead>
        <tbody>{data.bySeat.map((row, index) => {
          const seat = seats.find(seat => seat.seat === row.seat);
          return <tr key={row.seat ?? index}><td>{seat ? namedSeat(seat, t) : t("analytics.agentIndex", { index: index + 1 })}</td>
            <td>{duration(row.activeMs)}</td><td>{percent(totals?.activeMs ? row.activeMs / totals.activeMs : null)}</td>
            <td>{row.attempts}</td><td>{count(row.tokens)}</td></tr>;
        })}</tbody>
      </table></div>}
    </section>
  </div>;
}
