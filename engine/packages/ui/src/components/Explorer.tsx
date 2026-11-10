import { useEffect, useMemo, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Boxes, ChevronLeft, ChevronRight, CircleDot, Globe, Layers3, Server, Activity } from "lucide-react";
import { useRigSummary, type RigSummary } from "../hooks/useRigSummary.js";
import { usePsEntries, type PsEntry } from "../hooks/usePsEntries.js";
import { useNodeInventory, type NodeInventoryEntry } from "../hooks/useNodeInventory.js";
import { cn } from "../lib/utils.js";
import { displayAgentName, displayPodName, inferPodName } from "../lib/display-name.js";
import {
  getActivityStateWithSource,
  getActivityLabel,
  getActivityTextClass,
  getActivityAnimationClass,
  getTimeInState,
  shortQitemTail,
} from "../lib/activity-visuals.js";
import { EmptyState } from "./ui/empty-state.js";
import { ProjectTreeView } from "./project/ProjectTreeView.js";
import { SpecsTreeView } from "./specs/SpecsTreeView.js";
import { SettingsExplorer } from "./system/SettingsExplorer.js";

import type { DrawerSelection } from "./SharedDetailDrawer.js";

export type ExplorerDesktopMode = "full" | "hidden";

export type ExplorerSurface = "project" | "specs" | "settings" | "none";

interface ExplorerProps {
  open: boolean;
  onClose: () => void;
  selection: DrawerSelection;
  onSelect: (sel: DrawerSelection) => void;
  desktopMode?: ExplorerDesktopMode;
  surface?: ExplorerSurface;
  onDesktopToggle?: () => void;
}

function statusColor(startupStatus: string | null): string {
  switch (startupStatus) {
    case "ready": return "text-green-600";
    case "pending": return "text-amber-500";
    case "attention_required": return "text-orange-500";
    case "failed": return "text-red-600";
    default: return "text-on-surface-variant";
  }
}

function rigStatusColor(status: string): string {
  switch (status) {
    case "running": return "text-green-600";
    case "partial": return "text-amber-500";
    case "stopped": return "text-on-surface-variant";
    default: return "text-on-surface-variant";
  }
}

function aggregateStatus(nodes: NodeInventoryEntry[]): "ready" | "pending" | "attention_required" | "failed" | null {
  if (nodes.some((node) => node.startupStatus === "failed")) return "failed";
  if (nodes.some((node) => node.startupStatus === "attention_required")) return "attention_required";
  if (nodes.some((node) => node.startupStatus === "pending")) return "pending";
  if (nodes.some((node) => node.startupStatus === "ready")) return "ready";
  return null;
}

function parseCurrentRigId(pathname: string): string | null {
  const match = pathname.match(/^\/rigs\/([^/]+)/);
  return match?.[1] ?? null;
}

function TreeToggle({
  expanded,
  label,
  onClick,
}: {
  expanded: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
      className="inline-flex h-5 w-5 items-center justify-center text-on-surface-variant transition-colors hover:text-on-surface"
    >
      <ChevronRight className={cn("h-4 w-4 transition-transform duration-150", expanded && "rotate-90")} />
    </button>
  );
}

// PL-019 item 3: per-row activity indicator that sits next to the
// startup-status icon. Uses the same shared palette as RigNode (item 2)
// so the operator's mental model is the same on both surfaces.
//
// "Owns active work" tag (qitem tooltip) renders only when the daemon
// attached one or more in-progress qitems on the node-detail/inventory
// payload — currentQitems comes from the read-side join in routes/sessions.ts
// + routes/rigs.ts.
function NodeActivityIndicator({ node }: { node: NodeInventoryEntry }) {
  const activity = node.agentActivity;
  const { state, source: activitySource } = getActivityStateWithSource(activity, node.terminalActive);
  const label = getActivityLabel(state, activity);
  const textClass = getActivityTextClass(state);
  const animClass = getActivityAnimationClass(state);
  const qitems = node.currentQitems ?? [];

  const sourceLabel = activitySource !== "hook" && activitySource !== "none" ? " (activity-grade)" : "";
  const timeInState = getTimeInState(activity);
  const durationSuffix = timeInState ? ` ${timeInState.label}` : "";
  const titleLines = [`activity: ${label}${durationSuffix}${sourceLabel}`];
  if (qitems.length > 0) {
    for (const q of qitems) {
      titleLines.push(`on ${shortQitemTail(q.qitemId)} — ${q.bodyExcerpt}`);
    }
  }
  const title = titleLines.join("\n");

  return (
    <span
      className="inline-flex items-center gap-0.5 ml-1"
      data-testid={`node-activity-${node.logicalId}`}
      data-activity-state={state}
      data-activity-source={activitySource}
      title={title}
    >
      <Activity className={cn("h-2.5 w-2.5 shrink-0", textClass, animClass)} strokeWidth={2.4} aria-label={title} />
      {qitems.length > 0 && (
        <span
          className="font-mono text-[8px] uppercase tracking-[0.10em] text-on-surface-variant"
          data-testid={`node-active-work-${node.logicalId}`}
          aria-label="owns active work"
        >
          ●
        </span>
      )}
    </span>
  );
}

function ExplorerKindIcon({
  kind,
  statusClass,
  testId,
}: {
  kind: "environment" | "rig" | "pod" | "agent" | "infrastructure";
  statusClass: string;
  testId?: string;
}) {
  const sizeClass = kind === "rig" ? "h-3.5 w-3.5" : "h-2.5 w-2.5";
  const sharedProps = {
    "data-testid": testId,
    className: cn(sizeClass, "shrink-0", statusClass),
    strokeWidth: 1.8,
  };

  switch (kind) {
    case "environment":
      return <Globe {...sharedProps} />;
    case "rig":
      return <Boxes {...sharedProps} />;
    case "pod":
      return <Layers3 {...sharedProps} />;
    case "infrastructure":
      return <Server {...sharedProps} />;
    default:
      return <CircleDot {...sharedProps} />;
  }
}


// Surface-routed body. Phase 2 lays placeholders for non-topology
// surfaces; Phase 3 fills tree contents + lens chips. "none" surface
// (Dashboard only — slice 26 promoted Settings to a 4-destination
// Explorer peer with its own SettingsExplorer surface) means Explorer
// is not rendered at all.
function SurfaceBody({
  surface,
  rigs,
  psMap,
  selection,
  onSelect,
  onClose,
  currentRigId,
}: {
  surface: ExplorerSurface;
  rigs: RigSummary[] | undefined;
  psMap: Map<string, PsEntry>;
  selection: DrawerSelection;
  onSelect: (sel: DrawerSelection) => void;
  onClose: () => void;
  currentRigId: string | null;
}) {
  if (surface === "project") {
    return <ProjectTreeView />;
  }
  if (surface === "specs") {
    return <SpecsTreeView />;
  }
  if (surface === "settings") {
    return <SettingsExplorer />;
  }
  return null;
}

export function Explorer({
  open,
  onClose,
  selection,
  onSelect,
  desktopMode = "full",
  surface = "none",
  onDesktopToggle = () => {},
}: ExplorerProps) {
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;
  const currentRigId = parseCurrentRigId(currentPath);
  const { data: rigs } = useRigSummary();
  const { data: psEntries } = usePsEntries();

  const psMap = new Map((psEntries ?? []).map((entry) => [entry.rigId, entry]));

  // Surface "none" (Dashboard only — Settings has its own Explorer
  // surface as of slice 26) — Explorer is not rendered.
  if (surface === "none") return null;

  const isCollapsed = desktopMode === "hidden";

  // When collapsed at desktop: render ONLY a floating toggle button
  // at left=rail-edge (no aside container behind it). The Explorer
  // surface tree is unmounted; the canvas + tabs reflow to fill the
  // freed width.
  if (isCollapsed) {
    return (
      <button
        type="button"
        data-testid="explorer-edge-toggle"
        data-explorer-collapsed="true"
        aria-label="Expand explorer"
        onClick={onDesktopToggle}
        className={cn(
          "hidden lg:flex fixed top-[5.5rem] left-[3.5rem] z-30 h-8 w-8 items-center justify-center",
          "rounded-full border border-outline-variant bg-background/90 text-on-surface",
          "shadow-[0_2px_8px_rgba(41,37,36,0.08)] backdrop-blur-sm transition-colors",
          "hover:bg-surface-low hover:text-on-surface",
        )}
      >
        <ChevronRight className="h-4 w-4" strokeWidth={1.5} />
      </button>
    );
  }

  return (
    <aside
      data-testid="explorer"
      data-surface={surface}
      data-explorer-mode="opaque"
      data-explorer-collapsed="false"
      className={cn(
        // V1 border weight doctrine (universal-shell.md L39–L48):
        // 1px outline-variant ghost line for inter-region edges.
        "border-r border-outline-variant flex overflow-hidden",
        // Keep the mobile drawer above the rail tray.
        "z-40 bg-[hsl(var(--background)/0.035)] supports-[backdrop-filter]:bg-[hsl(var(--background)/0.018)] backdrop-blur-[14px] backdrop-saturate-75 shadow-[6px_0_14px_rgba(46,52,46,0.04)]",
        // Mobile: slide-over from left below the top-bar header (h-14).
        "fixed top-14 bottom-0 left-0 transition-transform duration-200 ease-tactical w-72 max-w-[80vw]",
        open ? "translate-x-0" : "-translate-x-full",
        // Desktop (>=lg): persistent column at 280px (lg:w-72) per
        // universal-shell.md L34. Positioned absolutely after the 48px
        // rail.
        "lg:absolute lg:top-0 lg:bottom-0 lg:left-12 lg:w-72 lg:max-w-none lg:translate-x-0",
      )}
    >
      <div className="relative flex h-full w-full flex-col">
        <button
          type="button"
          data-testid="explorer-edge-toggle"
          aria-label="Collapse explorer"
          onClick={onDesktopToggle}
          className={cn(
            "hidden lg:flex absolute z-10 h-8 w-8 items-center justify-center rounded-full border border-outline-variant bg-background/90 text-on-surface",
            "shadow-[0_2px_8px_rgba(41,37,36,0.08)] backdrop-blur-sm transition-colors hover:bg-surface-low hover:text-on-surface",
            "right-2 top-3",
          )}
        >
          <ChevronLeft className="h-4 w-4" strokeWidth={1.5} />
        </button>

        <SurfaceBody
          surface={surface}
          rigs={rigs}
          psMap={psMap}
          selection={selection}
          onSelect={onSelect}
          onClose={onClose}
          currentRigId={currentRigId}
        />
      </div>
    </aside>
  );
}
