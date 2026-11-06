import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { TeamOwnerRead, TeamReviewView } from "@openrig/daemon/team-control";
import { useOwnerSession } from "../hooks/useOwnerSession.js";
import { mergeBranch, type IntegrationState } from "./clients.js";
import { branchName, isFinished, readableBranch, seatLabel, stateLabel, stateOf, taskName } from "./display.js";
import { ChevronRight } from "./glyphs.js";
import { useIntegration, useTeamChat } from "./hooks.js";
import { LeadConversation } from "./chat-panel.js";

/**
 * U10 — the run home.
 *
 * The lead's conversation is the protagonist: text turns, and the decisions it needs as plates
 * in the record. Beside it the run's tasks are one line that ends at the merge plate, which
 * stays closed until U7 says the branch can merge. The lead admits its own task list now, so
 * the plate here approves the plan and nothing else.
 */
export function RunHome({ read, runId, available, now, onOpenTask, onOpenBranch }: {
  read?: TeamOwnerRead; runId: string; available: boolean; now: number;
  onOpenTask: (taskId: string) => void; onOpenBranch: () => void;
}) {
  const { t } = useTranslation();
  const chat = useTeamChat(runId, available);
  const integration = useIntegration(runId, available);
  const tasks = read?.tasks ?? [];
  const remaining = tasks.filter(task => !isFinished(task)).length;
  const [draft, setDraft] = useState("");

  return <>
    <button className="line-strip" onClick={onOpenBranch}>
      <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span className="label">{t("team.line.title")}</span>
        <span className="now">{activeName(tasks, t) ?? "—"}</span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span className="count">{tasks.length - remaining} / {tasks.length}</span>
        <ChevronRight />
      </span>
    </button>

    <main className="home">
      <LeadConversation read={read} runId={runId} chat={chat.data} draft={draft} onDraftChange={setDraft} />

      <aside className="line-scroll" aria-label={t("team.line.title")}>
        <div className="line">
          <div className="line-head"><h2>{t("team.line.title")}</h2></div>
          <div className="line-body">
            {tasks.map(task => <TaskRow key={task.qitemId} task={task} seats={read?.seats ?? []} onOpen={() => onOpenTask(task.taskId)} />)}
          </div>
          <MergePlate read={read} remaining={remaining} integration={integration.data} onOpenBranch={onOpenBranch} now={now} />
        </div>
      </aside>
    </main>
  </>;
}

function activeName(tasks: readonly TeamReviewView[], t: TFunction): string | null {
  const activeTask = tasks.find(task => !isFinished(task) && stateOf(task) !== "queued") ?? tasks.find(task => !isFinished(task));
  return activeTask ? `${taskName(activeTask, t)} · ${stateLabel(stateOf(activeTask), t)}` : null;
}

function TaskRow({ task, seats, onOpen }: { task: TeamReviewView; seats: TeamOwnerRead["seats"]; onOpen: () => void }) {
  const { t } = useTranslation();
  const state = stateOf(task);
  return <button className="task" data-state={state} onClick={onOpen}>
    <span className="node" aria-hidden="true" />
    <span><span className="task-name">{taskName(task, t)}</span><span className="task-seat">{seatLabel(task.role, seats, t)}</span></span>
    <span className="task-state">{stateLabel(state, t)}</span>
  </button>;
}

/** The line's terminus. Open until U7 says the branch can merge — the gate is the point. */
function MergePlate({ read, remaining, integration, onOpenBranch }: {
  read?: TeamOwnerRead; remaining: number; integration?: IntegrationState; onOpenBranch: () => void; now: number;
}) {
  const { t } = useTranslation();
  const { request } = useOwnerSession();
  const [busy, setBusy] = useState(false);
  const available = integration?.available === true;
  const canMerge = available && integration!.merge.possible && remaining === 0;
  const state = remaining > 0 ? t("team.line.waitingOn", { count: remaining })
    : !available ? t("team.merge.unavailable")
      : canMerge ? t("team.merge.ready", { count: integration!.commits.length })
        : t("team.merge.blocked");
  return <div className="merge" data-ready={canMerge ? "true" : "false"}>
    <h3 className="mono" style={{ fontSize: 14, fontWeight: 500 }}>{readableBranch(integration?.branch ?? "") || (read ? branchName(read.run.displayName) : t("team.branch.title"))}</h3>
    <p>{state}</p>
    <button className="btn btn-outline" disabled={!canMerge || busy} onClick={async () => {
      if (!read || !canMerge) return;
      setBusy(true);
      try { await mergeBranch(request, read.runId, read.run.entityVersion); } finally { setBusy(false); }
    }}>{t("team.merge.action")}</button>
    <button className="merge-link" onClick={onOpenBranch}>{t("team.branch.title")}<ChevronRight /></button>
  </div>;
}