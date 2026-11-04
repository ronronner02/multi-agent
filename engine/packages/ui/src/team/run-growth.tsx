import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { ControlReceipt, ControlRequest, TeamRun } from "@openrig/daemon/team-control";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { OwnerReadError, useOwnerSession } from "../hooks/useOwnerSession.js";

export function RunGrowthForm({ runId, anchorTaskId }: { runId: string; anchorTaskId: string }) {
  const { t } = useTranslation(), session = useOwnerSession(), cache = useQueryClient();
  const [taskId, setTaskId] = useState(""), [seat, setSeat] = useState(""), [paths, setPaths] = useState("");
  const [body, setBody] = useState(""), [dependencies, setDependencies] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<"" | "edit.plan-change-required" | "edit.conflict" | "edit.unknown" | "edit.error" | "team.requested">("");
  const pending = useRef<{ path: string; request: ControlRequest<unknown> } | null>(null);
  const query = useQuery({ queryKey: ["team", runId, "growth"], enabled: session.paired, retry: false,
    queryFn: ({ signal }) => session.request<{ run: TeamRun }>(`/runs/${encodeURIComponent(runId)}`, { signal }) });
  const run = query.data?.run;
  const ready = !!run && !query.isFetching && !query.isError && ["approved", "invalidated"].includes(run.state);
  const locked = busy || !!pending.current || message === "team.requested" || !session.paired || !ready;
  const values = (value: string) => value.split(",").map(part => part.trim()).filter(Boolean);
  const submit = async () => {
    if (busy || !session.paired || message === "team.requested" || !pending.current && !ready) return;
    setBusy(true);
    try {
      if (!pending.current) {
        const task = { assignment: { taskId: taskId.trim(), role: "implementer", paths: values(paths), dependencies: values(dependencies) },
          destinationSession: seat.trim(), body: body.trim() };
        const request = (actionId: string, expectedEntityVersion: number, payload: unknown): ControlRequest<unknown> => ({
          protocolVersion: "1.0", runId, actionId, expectedEntityVersion, idempotencyKey: crypto.randomUUID(), payload,
        });
        if (run!.state === "approved") {
          const path = `/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(anchorTaskId)}/edit`;
          const edit = await session.request<{ runVersion: number; task: { taskVersion: number } }>(path);
          pending.current = { path, request: request(anchorTaskId, edit.runVersion, {
            expectedTaskVersion: edit.task.taskVersion, changes: { addTask: task },
          }) };
        } else {
          pending.current = { path: `/runs/${encodeURIComponent(runId)}/growth`, request: request(crypto.randomUUID(), run!.entityVersion, {
            writePaths: [...new Set([...run!.binding.writePaths, ...task.assignment.paths])], tasks: [task],
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          }) };
        }
      }
      const sent = pending.current;
      const receipt = await session.request<ControlReceipt<{ classification?: string; state?: string }>>(sent.path, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sent.request),
      });
      if (receipt.status !== "accepted") throw new OwnerReadError(403, receipt.reason ?? "control_denied");
      const growth = sent.path.endsWith("/growth");
      if (growth ? receipt.value?.state !== "pending" : receipt.value?.classification !== "plan-change-required") {
        throw new Error("Missing run growth receipt");
      }
      pending.current = null;
      setMessage(growth ? "team.requested" : "edit.plan-change-required");
      await cache.invalidateQueries({ queryKey: ["team", runId] });
    } catch (error) {
      if (error instanceof OwnerReadError && error.status < 500) {
        pending.current = null; setMessage(error.status === 409 ? "edit.conflict" : "edit.error");
        await query.refetch();
      } else setMessage(pending.current ? "edit.unknown" : "edit.error");
    } finally { setBusy(false); }
  };
  return <Card className="team-card" role="region" aria-label={t("edit.addTask")}>
    <h2>{t("edit.addTask")}</h2><p>{t("edit.suspensionWarning")}</p>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label>{t("web.taskId")}<input required value={taskId} disabled={locked} maxLength={256} onChange={event => setTaskId(event.target.value)} /></label>
      <label>{t("web.session")}<input required value={seat} disabled={locked} maxLength={256} onChange={event => setSeat(event.target.value)} /></label>
      <label>{t("web.files")}<input required value={paths} disabled={locked} onChange={event => setPaths(event.target.value)} /></label>
      <label>{t("web.dependencies")}<input value={dependencies} disabled={locked} onChange={event => setDependencies(event.target.value)} /></label>
      <label>{t("web.goal")}<textarea required value={body} disabled={locked} maxLength={262_144} onChange={event => setBody(event.target.value)} /></label>
      <Button type="submit" variant="outline" disabled={busy || !session.paired || message === "team.requested"
        || !pending.current && (!ready || !taskId.trim() || !seat.trim() || !values(paths).length || !body.trim())}>
        {t(message === "edit.unknown" ? "edit.retryExact" : "edit.submit")}
      </Button>
    </form>
    {message && <p role={message === "team.requested" ? "status" : "alert"}>{t(message)}</p>}
    {message === "team.requested" && <a href={`/team/overview?run=${encodeURIComponent(runId)}`}>{t("web.pendingDecisions")}</a>}
    {query.isError && <p role="alert">{t("edit.error")}</p>}
  </Card>;
}
