/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { FlowIntent, FlowMapping, FlowNode, FlowNodeState } from "./flow-events.js";

/**
 * The beam phases and the broadcast ripple follow the charge/travel/linger choreography in
 * scion's `extras/agent-viz/web/src/comms.ts`, `messages.ts`, `agents.ts`, and `destroy-beam.ts`.
 * The implementation below is intentionally self-contained and uses the command-center token
 * vocabulary instead of scion's palette.
 */

export const FLOW_BEAM_TIMINGS = {
  chargeMs: 300,
  travelMs: 600,
  lingerMs: 500,
  rippleMs: 1_000,
  localPulseMs: 700,
} as const;

export type FlowColorToken =
  | "--ui-accent"
  | "--ui-accent-press"
  | "--ui-ok"
  | "--ui-warn"
  | "--ui-error"
  | "--ui-text"
  | "--ui-muted"
  | "--ui-divider";

export interface FlowRendererColors {
  accent: string;
  accentPress: string;
  ok: string;
  warn: string;
  error: string;
  text: string;
  muted: string;
  divider: string;
}

export interface FlowRendererOptions {
  canvas?: HTMLCanvasElement | null;
  maxParticles?: number;
  colors?: Partial<FlowRendererColors>;
}

export interface FlowPoint {
  x: number;
  y: number;
}

const TOKEN_NAMES: Record<keyof FlowRendererColors, FlowColorToken> = {
  accent: "--ui-accent",
  accentPress: "--ui-accent-press",
  ok: "--ui-ok",
  warn: "--ui-warn",
  error: "--ui-error",
  text: "--ui-text",
  muted: "--ui-muted",
  divider: "--ui-divider",
};

const DEFAULT_COLORS: FlowRendererColors = {
  accent: "var(--ui-accent)",
  accentPress: "var(--ui-accent-press)",
  ok: "var(--ui-ok)",
  warn: "var(--ui-warn)",
  error: "var(--ui-error)",
  text: "var(--ui-text)",
  muted: "var(--ui-muted)",
  divider: "var(--ui-divider)",
};

/** Pattern-only density formula inspired by openspawn PR #155; no openspawn code is copied. */
export function edgeWidthForCount(count: number): number {
  return Math.min(1.25 + Math.log(Math.max(0, count) + 1) * 0.8, 5.5);
}

/** Pattern-only particle tiers inspired by openspawn PR #155. */
export function particleTierForCount(count: number): 0 | 1 | 2 | 3 {
  if (count <= 0) return 0;
  if (count < 5) return 1;
  if (count < 20) return 2;
  return 3;
}

/** Pattern-only heat thresholds inspired by openspawn PR #155. */
export function heatLevelForActivity(count: number): "idle" | "cool" | "warm" | "hot" {
  if (count >= 24) return "hot";
  if (count >= 8) return "warm";
  if (count > 0) return "cool";
  return "idle";
}

export function layoutFlowNodes(nodes: readonly FlowNode[], width: number, height: number): Map<string, FlowPoint> {
  const points = new Map<string, FlowPoint>();
  if (!nodes.length) return points;
  const center = { x: width / 2, y: height / 2 };
  const radius = Math.max(70, Math.min(width, height) * 0.34);
  const leadIndex = Math.max(0, nodes.findIndex(node => node.role === "lead" || node.id === "lead"));
  const ordered = [nodes[leadIndex], ...nodes.filter((_, index) => index !== leadIndex)].filter((node): node is FlowNode => Boolean(node));
  ordered.forEach((node, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / ordered.length;
    points.set(node.id, { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
  });
  return points;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function easeOut(value: number): number {
  return 1 - Math.pow(1 - clamp01(value), 3);
}

function easeInOut(value: number): number {
  const t = clamp01(value);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function rgba(color: string, alpha: number): string {
  if (color.startsWith("var(")) return color;
  if (color.startsWith("rgb(")) return color.replace(/^rgb\((.*)\)$/, `rgb($1 / ${alpha})`);
  if (color.startsWith("rgba(")) return color;
  return color;
}

function drawRoundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function readToken(canvas: HTMLCanvasElement | null | undefined, token: FlowColorToken): string {
  const doc = canvas?.ownerDocument;
  const view = doc?.defaultView;
  if (view && canvas) {
    const own = view.getComputedStyle(canvas);
    const value = own.getPropertyValue(token).trim();
    if (value) return value;
    const root = view.getComputedStyle(doc.documentElement);
    const rootValue = root.getPropertyValue(token).trim();
    if (rootValue) return rootValue;
  }
  return `var(${token})`;
}

function nodeColor(node: FlowNode, colors: FlowRendererColors): string {
  switch (node.state) {
    case "error": return colors.error;
    case "waiting":
    case "ambiguous":
    case "no-response": return colors.warn;
    case "complete": return colors.ok;
    case "started":
    case "acknowledged":
    case "working": return colors.accentPress;
    default: return node.role === "lead" ? colors.accent : colors.muted;
  }
}

function eventAge(intent: FlowIntent, now: number): number {
  // Browser rAF timestamps are monotonic; durable events are epoch timestamps. Supporting both
  // keeps the renderer useful in tests and when a caller uses `Date.now()` for a replay frame.
  const eventIsEpoch = intent.createdAt > 100_000_000_000;
  const frameIsEpoch = now > 100_000_000_000;
  if (eventIsEpoch !== frameIsEpoch) return eventIsEpoch ? Math.max(0, Date.now() - intent.createdAt) : Math.max(0, performance.now() - intent.createdAt);
  return Math.max(0, now - intent.createdAt);
}

export class FlowRenderer {
  private nodes: FlowNode[] = [];
  private intents: FlowIntent[] = [];
  private positions = new Map<string, FlowPoint>();
  private width = 640;
  private height = 420;
  private readonly canvas: HTMLCanvasElement | null;
  private readonly maxParticles: number;
  private readonly colors: FlowRendererColors;

  constructor(options: FlowRendererOptions = {}) {
    this.canvas = options.canvas ?? null;
    this.maxParticles = options.maxParticles ?? 96;
    this.colors = {
      ...Object.fromEntries(Object.entries(TOKEN_NAMES).map(([key, token]) => [key, readToken(this.canvas, token)])),
      ...options.colors,
    } as FlowRendererColors;
  }

  setModel(model: Pick<FlowMapping, "nodes" | "intents">): void {
    this.nodes = model.nodes.slice();
    this.intents = model.intents.slice(-this.maxParticles);
    this.positions = layoutFlowNodes(this.nodes, this.width, this.height);
  }

  setNodes(nodes: readonly FlowNode[]): void {
    this.nodes = nodes.slice();
    this.positions = layoutFlowNodes(this.nodes, this.width, this.height);
  }

  setIntents(intents: readonly FlowIntent[]): void {
    this.intents = intents.slice(-this.maxParticles);
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.positions = layoutFlowNodes(this.nodes, this.width, this.height);
  }

  getNodePositions(): ReadonlyMap<string, FlowPoint> {
    return this.positions;
  }

  draw(ctx: CanvasRenderingContext2D, now = Date.now()): void {
    ctx.clearRect(0, 0, this.width, this.height);
    this.drawRing(ctx);
    this.drawEdges(ctx);
    for (const intent of this.intents) this.drawIntent(ctx, intent, now);
    for (const node of this.nodes) this.drawNode(ctx, node, now);
  }

  private drawRing(ctx: CanvasRenderingContext2D): void {
    const center = { x: this.width / 2, y: this.height / 2 };
    const radius = Math.max(70, Math.min(this.width, this.height) * 0.34);
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = rgba(this.colors.divider, 0.8);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  private drawEdges(ctx: CanvasRenderingContext2D): void {
    const edges = new Map<string, { source: FlowPoint; target: FlowPoint; count: number }>();
    for (const intent of this.intents) {
      if (!intent.targetId || intent.kind === "static") continue;
      const source = this.positions.get(intent.sourceId);
      const target = this.positions.get(intent.targetId);
      if (!source || !target) continue;
      const key = `${intent.sourceId}:${intent.targetId}`;
      const existing = edges.get(key);
      if (existing) existing.count += intent.count;
      else edges.set(key, { source, target, count: intent.count });
    }
    ctx.save();
    for (const edge of edges.values()) {
      ctx.beginPath();
      ctx.moveTo(edge.source.x, edge.source.y);
      ctx.lineTo(edge.target.x, edge.target.y);
      ctx.strokeStyle = rgba(this.colors.divider, 0.65);
      ctx.lineWidth = edgeWidthForCount(edge.count);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawIntent(ctx: CanvasRenderingContext2D, intent: FlowIntent, now: number): void {
    const source = this.positions.get(intent.sourceId);
    if (!source) return;
    if (intent.kind === "static") return;
    if (intent.kind === "activity") {
      this.drawLocalPulse(ctx, source, eventAge(intent, now), intent.count);
      return;
    }
    if (intent.kind === "lead-message") {
      this.drawRipple(ctx, source, eventAge(intent, now));
      return;
    }
    const target = intent.targetId ? this.positions.get(intent.targetId) : null;
    if (!target) return;
    this.drawBeam(ctx, source, target, intent, eventAge(intent, now));
  }

  private drawBeam(ctx: CanvasRenderingContext2D, source: FlowPoint, target: FlowPoint, intent: FlowIntent, elapsed: number): void {
    const { chargeMs, travelMs, lingerMs } = FLOW_BEAM_TIMINGS;
    const total = chargeMs + travelMs + lingerMs;
    if (elapsed >= total) return;
    const color = intent.kind === "review" ? this.colors.warn : intent.kind === "integration" ? this.colors.ok : this.colors.accent;
    ctx.save();
    if (elapsed < chargeMs) {
      const t = elapsed / chargeMs;
      const pulse = 0.3 + 0.7 * Math.sin(t * Math.PI * 4);
      ctx.globalAlpha = Math.max(0, pulse * t);
      ctx.shadowBlur = 18;
      ctx.shadowColor = color;
      ctx.beginPath();
      ctx.arc(source.x, source.y, 8 + 5 * t, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    } else if (elapsed < chargeMs + travelMs) {
      const t = easeOut((elapsed - chargeMs) / travelMs);
      const end = { x: source.x + (target.x - source.x) * t, y: source.y + (target.y - source.y) * t };
      this.strokeBeam(ctx, source, end, color, 1);
      ctx.shadowBlur = 10;
      ctx.shadowColor = color;
      ctx.beginPath();
      ctx.arc(end.x, end.y, 3 + Math.min(3, intent.count), 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      const t = (elapsed - chargeMs - travelMs) / lingerMs;
      ctx.globalAlpha = 1 - clamp01(t);
      this.strokeBeam(ctx, source, target, color, 1 - clamp01(t));
      ctx.beginPath();
      ctx.arc(target.x, target.y, 9 + 18 * clamp01(t), 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 * (1 - clamp01(t));
      ctx.stroke();
    }
    ctx.restore();
  }

  private strokeBeam(ctx: CanvasRenderingContext2D, source: FlowPoint, target: FlowPoint, color: string, alpha: number): void {
    ctx.save();
    ctx.globalAlpha = alpha * 0.22;
    ctx.shadowBlur = 14;
    ctx.shadowColor = color;
    ctx.beginPath();
    ctx.moveTo(source.x, source.y);
    ctx.lineTo(target.x, target.y);
    ctx.strokeStyle = color;
    ctx.lineWidth = 8;
    ctx.stroke();
    ctx.globalAlpha = alpha * 0.65;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  private drawRipple(ctx: CanvasRenderingContext2D, source: FlowPoint, elapsed: number): void {
    const t = clamp01(elapsed / FLOW_BEAM_TIMINGS.rippleMs);
    if (t >= 1) return;
    const center = { x: this.width / 2, y: this.height / 2 };
    const eased = easeOut(t);
    const x = source.x + (center.x - source.x) * eased;
    const y = source.y + (center.y - source.y) * eased;
    const radius = 18 + Math.max(42, Math.min(this.width, this.height) * 0.34) * eased;
    ctx.save();
    ctx.globalAlpha = 0.8 * (1 - eased);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = this.colors.accent;
    ctx.lineWidth = 2.5 * (1 - eased * 0.45);
    ctx.shadowBlur = 8 * (1 - eased);
    ctx.shadowColor = this.colors.accent;
    ctx.stroke();
    ctx.restore();
  }

  private drawLocalPulse(ctx: CanvasRenderingContext2D, point: FlowPoint, elapsed: number, count: number): void {
    const t = clamp01(elapsed / FLOW_BEAM_TIMINGS.localPulseMs);
    if (t >= 1) return;
    const radius = 12 + 20 * easeOut(t);
    ctx.save();
    ctx.globalAlpha = (1 - t) * Math.min(1, 0.45 + count / 10);
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = this.colors.accentPress;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  private drawNode(ctx: CanvasRenderingContext2D, node: FlowNode, now: number): void {
    const point = this.positions.get(node.id);
    if (!point) return;
    const heat = heatLevelForActivity(node.activityCount);
    const color = nodeColor(node, this.colors);
    const baseRadius = node.role === "lead" ? 22 : 18;
    const pulse = node.state === "working" || node.state === "started" ? 1 + 0.04 * Math.sin(now / 140) : 1;
    const radius = baseRadius * pulse;
    ctx.save();
    if (heat !== "idle") {
      ctx.globalAlpha = heat === "hot" ? 0.24 : heat === "warm" ? 0.16 : 0.1;
      ctx.shadowBlur = heat === "hot" ? 22 : 14;
      ctx.shadowColor = color;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius + 8, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = rgba(this.colors.divider, 0.92);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = node.role === "lead" ? 3 : 2;
    ctx.stroke();
    this.drawStateGlyph(ctx, point, radius, node.state, color);
    ctx.restore();
  }

  private drawStateGlyph(ctx: CanvasRenderingContext2D, point: FlowPoint, radius: number, state: FlowNodeState, color: string): void {
    if (state === "idle" || state === "working" || state === "started" || state === "acknowledged" || state === "complete") {
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius * 0.32, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      return;
    }
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    if (state === "error") {
      ctx.beginPath();
      ctx.moveTo(point.x - 5, point.y - 5);
      ctx.lineTo(point.x + 5, point.y + 5);
      ctx.moveTo(point.x + 5, point.y - 5);
      ctx.lineTo(point.x - 5, point.y + 5);
      ctx.stroke();
    } else if (state === "ambiguous") {
      ctx.beginPath();
      ctx.moveTo(point.x, point.y - 7);
      ctx.lineTo(point.x + 7, point.y + 6);
      ctx.lineTo(point.x - 7, point.y + 6);
      ctx.closePath();
      ctx.stroke();
    } else if (state === "no-response") {
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius * 0.42, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius * 0.34, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}

export function rendererColors(canvas: HTMLCanvasElement | null): FlowRendererColors {
  return Object.fromEntries(Object.entries(TOKEN_NAMES).map(([key, token]) => [key, readToken(canvas, token)])) as unknown as FlowRendererColors;
}
