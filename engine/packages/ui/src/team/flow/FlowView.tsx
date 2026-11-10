import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { MessageKey } from "@openrig/i18n";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion.js";
import { mapTeamEvents, type FlowEvent, type FlowIntent, type FlowNode, type FlowSeat } from "./flow-events.js";
import { FlowRenderer } from "./flow-renderer.js";
import "./flow.css";

export interface FlowViewProps {
  events: readonly FlowEvent[];
  seats?: readonly FlowSeat[];
  title?: string;
  className?: string;
  maxParticles?: number;
}

/** The intent kinds whose provider label is data (a tool name, a verdict), shown after the kind. */
const DETAILED_KINDS = new Set(["activity", "review"]);

function nodeStyle(index: number, count: number): CSSProperties {
  const angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(1, count);
  return {
    left: `${50 + Math.cos(angle) * 38}%`,
    top: `${50 + Math.sin(angle) * 38}%`,
  };
}

function setSelectedFromKeyboard(event: ReactKeyboardEvent<HTMLButtonElement>, select: () => void): void {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    select();
  }
}

export function FlowView({ events, seats, title, className, maxParticles }: FlowViewProps) {
  const { t } = useTranslation();
  const reducedMotion = usePrefersReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<FlowRenderer | null>(null);
  const [canvasAvailable, setCanvasAvailable] = useState<boolean | null>(null);
  const [manualPaused, setManualPaused] = useState(false);
  const [windowPaused, setWindowPaused] = useState(() => typeof document !== "undefined" && document.hidden);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const mapping = useMemo(() => mapTeamEvents(events, { seats, maxParticles }), [events, maxParticles, seats]);
  const paused = manualPaused || windowPaused || reducedMotion;
  const orderedNodes = useMemo(() => {
    const lead = mapping.nodes.find(node => node.role === "lead" || node.id === "lead");
    return lead ? [lead, ...mapping.nodes.filter(node => node.id !== lead.id)] : mapping.nodes;
  }, [mapping.nodes]);

  useEffect(() => {
    if (selectedNode && !mapping.nodes.some(node => node.id === selectedNode)) setSelectedNode(null);
  }, [mapping.nodes, selectedNode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let context: CanvasRenderingContext2D | null = null;
    try {
      context = canvas.getContext("2d");
    } catch {
      context = null;
    }
    setCanvasAvailable(Boolean(context));
    if (!context) return;
    const renderer = rendererRef.current ?? new FlowRenderer({ canvas, maxParticles });
    rendererRef.current = renderer;
    renderer.setModel(mapping);

    const resize = () => {
      const stage = stageRef.current;
      const width = stage?.clientWidth || 640;
      const height = Math.max(320, stage?.clientHeight || 420);
      const ratio = typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      if (typeof context.setTransform === "function") context.setTransform(ratio, 0, 0, ratio, 0, 0);
      renderer.resize(width, height);
    };
    resize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    if (observer && stageRef.current) observer.observe(stageRef.current);
    return () => observer?.disconnect();
  }, [mapping, maxParticles]);

  useEffect(() => {
    const onBlur = () => setWindowPaused(true);
    const onFocus = () => setWindowPaused(false);
    const onVisibility = () => setWindowPaused(document.hidden);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const renderer = rendererRef.current;
    if (!canvas || !renderer || !canvasAvailable || paused) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let frame = 0;
    let active = true;
    const draw = (timestamp: number) => {
      if (!active) return;
      renderer.draw(context, timestamp);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      active = false;
      cancelAnimationFrame(frame);
    };
  }, [canvasAvailable, paused, mapping]);

  const showStaticList = reducedMotion || canvasAvailable === false;
  const selected = selectedNode ? mapping.nodes.find(node => node.id === selectedNode) : null;
  const stateText = (state: FlowNode["state"]) => t(`flow.state.${state}` as MessageKey);
  const roleText = (role: FlowNode["role"]) => t(`flow.role.${role}` as MessageKey);
  // The default lead node carries the mapping's English placeholder; a seat's own name is data.
  const nameOf = (node: FlowNode) => node.role === "lead" && node.label === "Lead" ? roleText("lead") : node.label;
  const nodeName = (id: string) => { const node = mapping.nodes.find(value => value.id === id); return node ? nameOf(node) : id; };
  const intentText = (intent: FlowIntent) => {
    const kind = intent.kind === "delivery" && intent.action.endsWith("denied") ? "delivery-denied" : intent.kind;
    const base = t(`flow.intent.${kind}` as MessageKey);
    const detail = DETAILED_KINDS.has(intent.kind) && intent.count <= 1 ? intent.label : null;
    const route = intent.targetId ? `${nodeName(intent.sourceId)} → ${nodeName(intent.targetId)}` : nodeName(intent.sourceId);
    return [base, detail, route].filter(Boolean).join(" · ");
  };
  return <section className={["flow-view", className].filter(Boolean).join(" ")} data-render-mode={showStaticList ? "static" : "canvas"}>
    <div className="flow-heading">
      <h2>{title ?? t("flow.title")}</h2>
      <button className="flow-pause btn btn-outline" type="button" onClick={() => setManualPaused(value => !value)} aria-pressed={manualPaused}>
        {manualPaused ? t("flow.resume") : t("flow.pause")}
      </button>
    </div>
    <div className="flow-stage" ref={stageRef} data-testid="flow-stage">
      <canvas ref={canvasRef} className="flow-canvas" aria-hidden="true" />
      <div className="flow-node-layer" role="list" aria-label={t("flow.seats")}>
        {orderedNodes.map((node, index) => {
          const isSelected = selectedNode === node.id;
          const nodeLabel = t("flow.nodeLabel", { name: nameOf(node), role: roleText(node.role), state: stateText(node.state) });
          return <button
            key={node.id}
            className="flow-node-label"
            style={nodeStyle(index, orderedNodes.length)}
            type="button"
            aria-label={nodeLabel}
            aria-pressed={isSelected}
            data-selected={isSelected ? "true" : "false"}
            data-state={node.state}
            onClick={() => setSelectedNode(node.id)}
            onKeyDown={event => setSelectedFromKeyboard(event, () => setSelectedNode(node.id))}
          >
            <span className="flow-node-dot" aria-hidden="true" />
            <span className="flow-node-name">{nameOf(node)}</span>
            <span className="flow-node-state">{stateText(node.state)}</span>
          </button>;
        })}
      </div>
      {showStaticList && <div className="flow-static-note" role="status">
        {reducedMotion ? t("flow.reducedMotion") : t("flow.canvasUnavailable")}
      </div>}
    </div>
    {selected && <p className="flow-selection" role="status" aria-label={t("flow.selectedName", { name: nameOf(selected) })}>
      {t("flow.selected", { name: nameOf(selected), state: stateText(selected.state) })}
    </p>}
    <div className="flow-events" aria-label={t("flow.eventList")}>
      <h3>{t("flow.events")}</h3>
      {mapping.intents.length ? <ol>
        {mapping.intents.map(intent => <li key={intent.id} data-kind={intent.kind}>
          <span>{intentText(intent)}</span>
          {intent.count > 1 && <span className="flow-event-count">×{intent.count}</span>}
        </li>)}
      </ol> : <p className="flow-empty">{t("flow.empty")}</p>}
    </div>
  </section>;
}

export default FlowView;
