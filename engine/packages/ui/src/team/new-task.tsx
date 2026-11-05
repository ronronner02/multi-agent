import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { OwnerReadError, useOwnerSession } from "../hooks/useOwnerSession.js";
import { Caret } from "./glyphs.js";
import { runsKey, type TeamSummary } from "./hooks.js";

/**
 * U10 — start a run from the UI.
 *
 * The same owner endpoint `rig team start` calls: the goal is the only required field, and the
 * team it runs on is chosen from the teams the daemon lists, so nobody types an id. A refused
 * start shows the daemon's own reason. Under U5 the same form opens a planning chat instead of
 * dispatching straight away; that is one flag on this request, which is why the form does not
 * grow a second shape.
 */
export function StartRunForm({ teams, onStarted }: {
  teams: TeamSummary[] | undefined; onStarted: (runId: string) => void;
}) {
  const { t } = useTranslation();
  const session = useOwnerSession();
  const cache = useQueryClient();
  const [goal, setGoal] = useState("");
  const [team, setTeam] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const chosen = team || teams?.[0]?.id || "";

  return <section className="plate" aria-label={t("web.newTask")}>
    <h2 className="plate-title">{t("web.newTask")}</h2>
    <form style={{ display: "grid", gap: 12 }} onSubmit={async event => {
      event.preventDefault();
      if (busy || !goal.trim()) return;
      setBusy(true); setFailure(null);
      try {
        const receipt = await session.request<{ runId: string }>("/runs", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ goal: goal.trim(), ...(chosen ? { rig: chosen } : {}) }),
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
        <label htmlFor="start-team">{t("team.teams.title")}</label>
        <label className="input select">
          <select id="start-team" value={chosen} onChange={event => setTeam(event.target.value)}>
            {(teams ?? []).map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
          <Caret />
        </label>
      </div>}
      {failure && <p role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>{t("web.startRefused")}</p>}
      <div className="plate-foot">
        <button className="btn btn-primary" type="submit" disabled={busy || !goal.trim() || !session.paired}>{t("web.startTask")}</button>
      </div>
    </form>
  </section>;
}