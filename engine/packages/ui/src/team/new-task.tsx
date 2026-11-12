import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { OwnerReadError, useOwnerSession } from "../hooks/useOwnerSession.js";
import { Caret, Close } from "./glyphs.js";
import { runsKey, type TeamSummary } from "./hooks.js";
import type { WorkflowSelection } from "@multi-agent/daemon/team-control";
import { WorkflowPicker } from "./workflows.js";

/**
 * U10 — start a run from the UI.
 *
 * The same owner endpoint `multi-agent team start` calls: the goal is the only required field, and the
 * team it runs on is chosen from the teams the daemon lists, so nobody types an id. A refused
 * start shows the daemon's own reason.
 *
 * A team with a lead seat starts in planning: the lead drafts the plan in the chat and the owner
 * approves it (U5). A team without one keeps the direct start, because there is nobody to plan
 * with. Both are the same request with one flag.
 */
export function StartRunForm({ teams, presetTeamId, onStarted }: {
  teams: TeamSummary[] | undefined; presetTeamId?: string; onStarted: (runId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const session = useOwnerSession();
  const cache = useQueryClient();
  const [goal, setGoal] = useState("");
  const [workflow, setWorkflow] = useState<WorkflowSelection | undefined>();
  const [team, setTeam] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const chosen = team || presetTeamId || teams?.[0]?.id || "";
  const hasLead = (teams ?? []).some(entry => entry.id === chosen && entry.seats.some(seat => seat.role === "lead"));

  return <section className="plate" aria-label={t(hasLead ? "planning.new" : "web.newTask")}>
    <h2 className="plate-title">{t(hasLead ? "planning.new" : "web.newTask")}</h2>
    <form style={{ display: "grid", gap: 12 }} onSubmit={async event => {
      event.preventDefault();
      if (busy || !goal.trim()) return;
      setBusy(true); setFailure(null);
      try {
        const receipt = await session.request<{ runId: string }>("/runs", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ goal: goal.trim(), responseLanguage: i18n.resolvedLanguage === "zh-CN" ? "zh-CN" : "en", ...(workflow ? { workflow } : {}), ...(chosen ? { rig: chosen } : {}), ...(hasLead ? { planning: true, documentWorkflow: true } : {}) }),
        });
        if (!receipt?.runId) throw new Error("no run");
        await cache.invalidateQueries({ queryKey: runsKey });
        setGoal("");
        onStarted(receipt.runId);
      } catch (error) {
        setFailure(error instanceof OwnerReadError ? error.code : "generic");
      } finally { setBusy(false); }
    }}>
      <div className="field">
        <label htmlFor="start-goal">{t("web.goal")}</label>
        <textarea id="start-goal" className="input" style={{ height: 96, padding: "10px 12px", resize: "vertical" }}
          value={goal} maxLength={262_144} required onChange={event => setGoal(event.target.value)} />
      </div>
      {(teams ?? []).length > 0 && <div className="field">
        <label htmlFor="start-team">{t("projects.title")}</label>
        <label className="input select">
          <select id="start-team" value={chosen} onChange={event => setTeam(event.target.value)}>
            {(teams ?? []).map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
          <Caret />
        </label>
      </div>}
      <WorkflowPicker value={workflow} onChange={setWorkflow} disabled={busy} />
      {failure && <p role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>{t("web.startRefused")}</p>}
      <div className="plate-foot">
        <button className="btn btn-primary" type="submit" disabled={busy || !goal.trim() || !session.paired}>{t(hasLead ? "planning.start" : "web.startTask")}</button>
      </div>
    </form>
  </section>;
}

/**
 * The same form as a sheet, so "new work" can open from the teams list and from a run that has
 * finished without navigating away. The sheet is not portalled: the shell's own element carries
 * the styles, and a fixed overlay renders correctly where it is declared.
 */
export function NewWorkSheet({ teams, teamId, open, onOpenChange, onStarted }: {
  teams: TeamSummary[] | undefined; teamId: string; open: boolean;
  onOpenChange: (open: boolean) => void; onStarted: (runId: string) => void;
}) {
  const { t } = useTranslation();
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Overlay className="scrim" />
    <Dialog.Content className="sheet" aria-label={t("team.teams.newWork")}>
      <header className="sheet-head">
        <Dialog.Title className="display" style={{ fontSize: 20, margin: 0 }}>{t("team.teams.newWork")}</Dialog.Title>
        <Dialog.Close className="more" aria-label={t("team.create.close")}><Close /></Dialog.Close>
      </header>
      <div className="sheet-body">
        <StartRunForm teams={teams} presetTeamId={teamId} onStarted={runId => { onOpenChange(false); onStarted(runId); }} />
      </div>
    </Dialog.Content>
  </Dialog.Root>;
}
