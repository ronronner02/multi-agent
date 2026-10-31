import { axisTicks, compactCount, type TokenDay } from "./analytics-model.js";

/**
 * Slice C — the two Analytics charts, drawn as inline SVG.
 *
 * `packages/ui` depends on no chart library, so these are plain SVG on the shell's own tokens:
 * a faint grid, labelled axes and one accent series. Both take their scale from the data they
 * are given, and neither draws a series it was not handed.
 */

const WIDTH = 640;
const HEIGHT = 220;
const PAD = { top: 12, right: 16, bottom: 30, left: 52 };

const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;

/** A y for a value under the same top tick the axis is drawn with. */
function yFor(value: number, top: number): number {
  return PAD.top + PLOT_H - (top === 0 ? 0 : (value / top) * PLOT_H);
}

function xFor(index: number, count: number): number {
  return PAD.left + (count <= 1 ? PLOT_W / 2 : (index / (count - 1)) * PLOT_W);
}

/** A short day label from a `YYYY-MM-DD` bucket key: the month and day the reader sorts by. */
function dayLabel(day: string): string {
  const [, month, date] = day.split("-");
  return `${month}-${date}`;
}

export function TokenChart({ series }: { series: TokenDay[] }) {
  const totals = series.map(day => day.input + day.output);
  const ticks = axisTicks(Math.max(...totals));
  const top = ticks.at(-1) ?? 0;
  const points = series.map((day, index) => `${xFor(index, series.length)},${yFor(totals[index]!, top)}`).join(" ");
  // A line with a single bucket has no segment to draw, so the point itself carries the value.
  const last = series.length - 1;
  return <svg className="ui-chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img">
    {ticks.map(tick => <g key={tick}>
      <line className="ui-chart-grid" x1={PAD.left} x2={WIDTH - PAD.right} y1={yFor(tick, top)} y2={yFor(tick, top)} />
      <text className="ui-chart-tick" x={PAD.left - 8} y={yFor(tick, top) + 4} textAnchor="end">{compactCount(tick)}</text>
    </g>)}
    <line className="ui-chart-axis" x1={PAD.left} x2={WIDTH - PAD.right} y1={PAD.top + PLOT_H} y2={PAD.top + PLOT_H} />
    {series.length > 1 && <polyline className="ui-chart-line" points={points} />}
    {series.map((day, index) => <circle key={day.day} className="ui-chart-point" cx={xFor(index, series.length)}
      cy={yFor(totals[index]!, top)} r={series.length === 1 ? 4 : 2.5} />)}
    {/* Every bucket is labelled while they fit; a longer window keeps the ends and thins the rest. */}
    {series.map((day, index) => (series.length <= 8 || index % 2 === 0 || index === last)
      ? <text key={`label-${day.day}`} className="ui-chart-tick" x={xFor(index, series.length)} y={HEIGHT - 10} textAnchor="middle">{dayLabel(day.day)}</text>
      : null)}
  </svg>;
}

export interface CostRow { key: string; label: string; costUsd: number }

/**
 * Horizontal bars on the same 640×220 frame as the token chart, so the two panels align.
 *
 * The plot height is fixed and the rows are distributed inside it, which keeps a two-row chart
 * from collapsing to a sliver beside a six-point line chart. Bars keep one thickness; only
 * their spacing changes.
 */
export function CostChart({ rows }: { rows: CostRow[] }) {
  const ticks = axisTicks(Math.max(...rows.map(row => row.costUsd)));
  const top = ticks.at(-1) ?? 0;
  const labelWidth = 148;
  const barLeft = labelWidth + 12;
  // Room for the value beside the longest bar, so a label never sits on top of its bar or
  // runs off the plot's right edge.
  const barWidth = WIDTH - barLeft - PAD.right - 56;
  const axisY = PAD.top + PLOT_H;
  const slot = rows.length ? PLOT_H / rows.length : PLOT_H;
  const barHeight = Math.min(22, slot * 0.45);
  return <svg className="ui-chart ui-chart-bars" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img">
    {ticks.map(tick => {
      const x = barLeft + (top === 0 ? 0 : (tick / top) * barWidth);
      return <g key={tick}>
        <line className="ui-chart-grid" x1={x} x2={x} y1={PAD.top} y2={axisY} />
        <text className="ui-chart-tick" x={x} y={HEIGHT - 10} textAnchor="middle">${tick}</text>
      </g>;
    })}
    {rows.map((row, index) => {
      const y = PAD.top + slot * index + slot / 2;
      const width = top === 0 ? 0 : (row.costUsd / top) * barWidth;
      const valueRight = barLeft + width + 8;
      return <g key={row.key} data-model={row.key}>
        <text className="ui-chart-label" x={0} y={y + 4}>{row.label}</text>
        <rect className="ui-chart-bar" x={barLeft} y={y - barHeight / 2} width={width} height={barHeight} rx={2} />
        <text className="ui-chart-tick" x={Math.min(valueRight, WIDTH - PAD.right)} y={y + 4}
          textAnchor={valueRight > WIDTH - PAD.right ? "end" : "start"}>${row.costUsd.toFixed(2)}</text>
      </g>;
    })}
  </svg>;
}
