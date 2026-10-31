import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TeamOwnerRead, TeamReplayEvent, TeamSystemHealth } from "@openrig/daemon/team-control";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../components/ui/tooltip.js";
import type { TerminalTarget } from "../bottom-panel.js";
import { AgentStatus } from "../agent-status.js";
import { KnowledgeView } from "../knowledge/knowledge-view.js";
import { WorkspaceView, type BrowseState } from "./workspace-view.js";
import { RunControlDialog, WorkspaceFocus } from "./workspace-focus.js";

/**
 * Slice B — Workspace, as one destination with a sub-navigation.
 *
 * Slice A mapped five surfaces here (the file browser, knowledge, agent monitoring, activity and
 * the evidence panel). Focus is the screen; the other surfaces stay reachable as sub-views, so
 * nothing that lived here lost its home. Grid and Split are named but disabled: the design places
 * them later, and a tooltip says so instead of a click doing nothing.
 */

export const WORKSPACE_VIEWS = ["focus", "browse", "knowledge", "agents"] as const;
export type WorkspaceViewName = (typeof WORKSPACE_VIEWS)[number];

export function LayoutSwitch() {
  const { t } = useTranslation();
  return <TooltipProvider delayDuration={150}>
    <div className="ui-viewswitch" role="group" aria-label={t("workspace.layout")}>
      {/* A disabled button swallows pointer events, so the tooltip hangs off a wrapper: the
          explanation is the only way to learn why the control does nothing. */}
      {(["grid", "split"] as const).map(name => <Tooltip key={name}>
        <TooltipTrigger asChild><span className="ui-viewswitch-later" tabIndex={0} aria-label={t("workspace.later")}>
          <button type="button" aria-pressed={false} disabled>{t(`workspace.${name}`)}</button>
        </span></TooltipTrigger>
        <TooltipContent>{t("workspace.laterHelp")}</TooltipContent>
      </Tooltip>)}
      <button type="button" aria-pressed>{t("workspace.focus")}</button>
      <span className="ui-viewswitch-note">{t("workspace.later")}</span>
    </div>
  </TooltipProvider>;
}

export function WorkspaceScreen({ read, runId, health, available, replay, browse, knowledge, evidence }: {
  read?: TeamOwnerRead; runId: string; available: boolean; health?: TeamSystemHealth;
  replay?: TeamReplayEvent[];
  browse: { state: BrowseState; onState: (state: BrowseState) => void };
  knowledge: { state: BrowseState; onState: (state: BrowseState) => void };
  evidence: { tab: string; onTab: (value: string) => void; target: TerminalTarget; onTarget: (target: TerminalTarget) => void };
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<WorkspaceViewName>("focus");
  const [control, setControl] = useState<"pause" | "stop" | null>(null);
  const [controlTrigger, setControlTrigger] = useState<HTMLElement | null>(null);
  const openControl = (action: "pause" | "stop") => (trigger: HTMLElement) => { setControlTrigger(trigger); setControl(action); };
  return <div className="ui-workspace">
    <header className="ui-page-head">
      <div>
        <h1>{t("workspace.title")}</h1>
        <p className="ui-subtitle">{t("workspace.subtitle")} · <code>{runId || "—"}</code></p>
      </div>
      <div className="ui-page-actions"><LayoutSwitch /></div>
    </header>
    <nav className="ui-subnav" aria-label={t("workspace.views")}>
      {WORKSPACE_VIEWS.map(name => <button key={name} type="button" aria-pressed={view === name} onClick={() => setView(name)}>{t(`workspace.view.${name}`)}</button>)}
    </nav>
    {view === "focus" && <WorkspaceFocus read={read} runId={runId} attempts={read?.attempts} available={available} replay={replay}
      onPause={openControl("pause")} onStop={openControl("stop")} evidence={evidence} />}
    {view === "browse" && <WorkspaceView runId={runId} state={browse.state} onState={browse.onState} tasks={read?.tasks} />}
    {view === "knowledge" && <KnowledgeView runId={runId} state={knowledge.state} onState={knowledge.onState} tasks={read?.tasks} />}
    {view === "agents" && <AgentStatus health={health} runId={runId} attempts={read?.attempts} />}
    <RunControlDialog action={control} run={read?.run} trigger={controlTrigger} available={available} onClose={() => setControl(null)} />
  </div>;
}
