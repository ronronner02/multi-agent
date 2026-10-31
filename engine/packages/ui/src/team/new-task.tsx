import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { TeamRunSummary, TeamStartReceipt } from "@openrig/daemon/team-control";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { OwnerReadError, useOwnerSession } from "../hooks/useOwnerSession.js";

/**
 * MVP slice 2 — start team work from the Web UI.
 *
 * A "New task" form that calls the same owner endpoint `rig team start` calls, and a run
 * selector fed by the run list, so nobody has to type an id.
 */

const runsKey = ["team", "runs"] as const;

/**
 * The run selector the command strip shows. It lists the runs the daemon returns, so the owner
 * picks one instead of typing an id; an empty or unavailable list keeps the current run visible.
 */
export function RunSelect({ current }: { current: string }) {
  const { t } = useTranslation(), session = useOwnerSession(), navigate = useNavigate();
  const query = useQuery({ queryKey: runsKey, enabled: session.paired, retry: false, refetchInterval: 5_000,
    queryFn: ({ signal }) => session.request<{ runs: TeamRunSummary[] }>("/runs", { signal }) });
  const runs = query.data?.runs ?? [];
  const known = runs.some(run => run.id === current);
  return <select className="ui-runselect" aria-label={t("shell.run")} value={current}
    onChange={event => void navigate({ to: "/team/$section", params: { section: "overview" }, search: { run: event.target.value || undefined } })}>
    {!current && <option value="">{t("shell.chooseRun")}</option>}
    {current && !known && <option value={current}>{current}</option>}
    {runs.map(run => <option key={run.id} value={run.id}>{run.id} · {run.rigName}</option>)}
  </select>;
}

export function NewTaskForm() {
  const { t } = useTranslation(), session = useOwnerSession(), navigate = useNavigate(), cache = useQueryClient();
  const [goal, setGoal] = useState("");
  const [rig, setRig] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<"refused" | "unavailable" | null>(null);
  return <Card className="team-card" role="region" aria-label={t("web.newTask")}>
    <h2>{t("web.newTask")}</h2>
    <form onSubmit={async event => {
      event.preventDefault();
      if (busy || !session.paired || !goal.trim()) return;
      setBusy(true); setFailure(null);
      try {
        const receipt = await session.request<TeamStartReceipt>("/runs", { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ goal: goal.trim(), ...(rig.trim() ? { rig: rig.trim() } : {}) }) });
        if (!receipt?.runId) throw new Error("The start returned no run.");
        await cache.invalidateQueries({ queryKey: runsKey });
        setGoal(""); setRig("");
        await navigate({ to: "/team/$section", params: { section: "overview" }, search: { run: receipt.runId } });
      } catch (error) {
        setFailure(error instanceof OwnerReadError && error.status < 500 ? "refused" : "unavailable");
      } finally { setBusy(false); }
    }}>
      <label>{t("web.goal")}<textarea value={goal} onChange={event => setGoal(event.target.value)}
        maxLength={262_144} required disabled={!session.paired} /></label>
      <label>{t("web.rig")}<input value={rig} onChange={event => setRig(event.target.value)}
        autoComplete="off" placeholder={t("web.rigDefault")} disabled={!session.paired} /></label>
      <Button type="submit" variant="outline" disabled={busy || !session.paired || !goal.trim()}>{t("web.startTask")}</Button>
    </form>
    {!session.paired && <p role="status">{t("web.pairRequired")}</p>}
    {failure && <p role="alert">{t(failure === "refused" ? "web.startRefused" : "web.error")}</p>}
  </Card>;
}
