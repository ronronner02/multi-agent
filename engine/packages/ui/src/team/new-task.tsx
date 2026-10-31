import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { TeamRunSummary, TeamStartReceipt } from "@openrig/daemon/team-control";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { OwnerReadError, useOwnerSession } from "../hooks/useOwnerSession.js";

/**
 * MVP slice 2 — start team work from the Web UI.
 *
 * A "New task" form that calls the same owner endpoint `rig team start` calls, and a list of
 * the runs that exist so nobody has to type an id. Both use the components the team view
 * already ships; a full restyle is a later slice, so this adds no styling of its own.
 */

const runsKey = ["team", "runs"] as const;

export function RunPicker({ current }: { current: string }) {
  const { t } = useTranslation(), session = useOwnerSession();
  const query = useQuery({ queryKey: runsKey, enabled: session.paired, retry: false, refetchInterval: 5_000,
    queryFn: ({ signal }) => session.request<{ runs: TeamRunSummary[] }>("/runs", { signal }) });
  const runs = query.data?.runs ?? [];
  return <Card className="team-card" role="region" aria-label={t("web.runs")}>
    <h2>{t("web.runs")}</h2>
    {query.isError ? <p role="alert">{t("web.error")}</p>
      : !session.paired ? <p>{t("web.pairRequired")}</p>
      : runs.length === 0 ? <p role="status">{t("web.noRuns")}</p>
      : <ul>{runs.map(run => <li key={run.id} aria-current={run.id === current ? "true" : undefined}>
        <Link to="/team/$section" params={{ section: "overview" }} search={{ run: run.id }}><code>{run.id}</code></Link>
        {" · "}{run.rigName}{" · "}{t(`status.run.${run.state}`)}
      </li>)}</ul>}
  </Card>;
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
