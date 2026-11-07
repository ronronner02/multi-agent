import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { axisTicks, compactCount, count, type TokenDay } from "./analytics-model.js";

const HEIGHT = 220;
const PAD = { top: 12, right: 24, bottom: 30, left: 52 };
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;

function useChartWidth() {
  const ref = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(640);
  useLayoutEffect(() => {
    const svg = ref.current!;
    const measure = () => { const next = svg.getBoundingClientRect().width; if (next > 0) setWidth(next); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

function yFor(value: number, top: number): number {
  return PAD.top + PLOT_H - (top === 0 ? 0 : (value / top) * PLOT_H);
}
function xFor(index: number, length: number, width: number): number {
  const plotWidth = width - PAD.left - PAD.right;
  return PAD.left + (length <= 1 ? plotWidth / 2 : (index / (length - 1)) * plotWidth);
}

/** The restored SVG chart leaves a gap for an attempt whose tokens were not captured. */
export function TokenChart({ series }: { series: TokenDay[] }) {
  const { t } = useTranslation();
  const { ref, width } = useChartWidth();
  const values = series.map(day => day.attempts === 0 ? 0 : day.tokens);
  const ticks = axisTicks(Math.max(0, ...values.map(value => value ?? 0)));
  const top = ticks.at(-1) ?? 0;
  const labelCount = Math.min(series.length, Math.max(2, Math.floor((width - PAD.left - PAD.right) / 64)));
  const labels = new Set(Array.from({ length: labelCount }, (_, index) => labelCount <= 1 ? 0
    : Math.round(index * (series.length - 1) / (labelCount - 1))));
  return <svg ref={ref} className="ui-chart" viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={t("analytics.tokensOverTime")}>
    <title>{t("analytics.tokensOverTime")}</title>
    {ticks.map(tick => <g key={tick}>
      <line className="ui-chart-grid" x1={PAD.left} x2={width - PAD.right} y1={yFor(tick, top)} y2={yFor(tick, top)} />
      <text className="ui-chart-tick" x={PAD.left - 8} y={yFor(tick, top) + 4} textAnchor="end">{compactCount(tick)}</text>
    </g>)}
    <line className="ui-chart-axis" x1={PAD.left} x2={width - PAD.right} y1={PAD.top + PLOT_H} y2={PAD.top + PLOT_H} />
    {series.map((day, index) => {
      const value = values[index], previous = values[index - 1];
      return <g key={day.day}>
        {value != null && previous != null && <line className="ui-chart-line" x1={xFor(index - 1, series.length, width)}
          y1={yFor(previous, top)} x2={xFor(index, series.length, width)} y2={yFor(value, top)} />}
        {value != null && <circle className="ui-chart-point" cx={xFor(index, series.length, width)} cy={yFor(value, top)} r={3}>
          <title>{day.day}: {value}</title></circle>}
        {labels.has(index) && <text className="ui-chart-tick"
          x={xFor(index, series.length, width)} y={HEIGHT - 10} textAnchor="middle">{day.day.slice(5)}</text>}
      </g>;
    })}
  </svg>;
}

export function ModelTokenChart({ rows }: { rows: Array<{ label: string; tokens: number | null }> }) {
  const { t } = useTranslation();
  const { ref, width } = useChartWidth();
  const height = Math.max(HEIGHT, rows.length * 64 + PAD.bottom + PAD.top);
  const plotHeight = height - PAD.top - PAD.bottom;
  const ticks = axisTicks(Math.max(0, ...rows.map(row => row.tokens ?? 0)));
  const top = ticks.at(-1) ?? 0;
  const barLeft = 8, barWidth = width - barLeft - 56;
  const slot = rows.length ? plotHeight / rows.length : plotHeight;
  const barHeight = Math.min(18, slot * 0.3);
  const maxLabel = Math.max(1, Math.floor(barWidth / 7));
  return <svg ref={ref} className="ui-chart ui-chart-bars" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t("analytics.tokensByModel")}>
    <title>{t("analytics.tokensByModel")}</title>
    {ticks.map(tick => {
      const x = barLeft + (top === 0 ? 0 : (tick / top) * barWidth);
      return <g key={tick}><line className="ui-chart-grid" x1={x} x2={x} y1={PAD.top} y2={PAD.top + plotHeight} />
        <text className="ui-chart-tick" x={x} y={height - 10} textAnchor={tick === 0 ? "start" : "middle"}>{compactCount(tick)}</text></g>;
    })}
    {rows.map((row, index) => {
      const y = PAD.top + slot * index + slot / 2;
      const length = top === 0 || row.tokens === null ? 0 : (row.tokens / top) * barWidth;
      return <g key={index}>
        <title>{row.label}: {count(row.tokens)}</title>
        <text className="ui-chart-label" x={barLeft} y={y - 16}>{row.label.length > maxLabel ? row.label.slice(0, maxLabel - 1) + "…" : row.label}</text>
        {row.tokens !== null && <rect className="ui-chart-bar" x={barLeft} y={y - barHeight / 2} width={length} height={barHeight} rx={2} />}
        <text className="ui-chart-tick" x={barLeft + barWidth + 8} y={y + 4}>{count(row.tokens)}</text>
      </g>;
    })}
  </svg>;
}
