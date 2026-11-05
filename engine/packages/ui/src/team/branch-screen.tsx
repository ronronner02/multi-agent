import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TeamOwnerRead } from "@openrig/daemon/team-control";
import { useOwnerSession } from "../hooks/useOwnerSession.js";
import { mergeBranch, type MergeOutcome } from "./clients.js";
import { isFinished, readableBranch, taskName } from "./display.js";
import { useIntegration } from "./hooks.js";

/**
 * U10 — the integration branch.
 *
 * The commits land in approval order on one branch, and the line runs into the merge plate at
 * its foot: the merge is the end of the line, not a button in a header. A commit carries the
 * run's task id; the name shown is the task's display name from the owner read, so the id never
 * reaches the page. A refusal is reported by its code's label, never by the daemon's prose,
 * which can name raw task ids.
 */
export function BranchScreen({ read, runId }: { read?: TeamOwnerRead; runId: string; onBack: () => void }) {
  const { t } = useTranslation();
  const { request } = useOwnerSession();
  const integration = useIntegration(runId, !!read);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<MergeOutcome | null>(null);

  const data = integration.data;
  const tasks = read?.tasks ?? [];
  const open = tasks.filter(task => !isFinished(task));
  const names = new Map(tasks.map(task => [task.taskId, taskName(task, t)]));
  const branch = readableBranch(data?.branch ?? "");
  const possible = data?.available === true && data.merge.possible === true;

  return <main className="branch">
    <div className="branch-head">
      <h1 className="display">{t("team.branch.title")}</h1>
      {branch && <div className="branch-ref"><span>{branch}</span></div>}
    </div>

    {!data?.available
      ? <p className="muted" style={{ padding: "32px 0" }}>{t("team.branch.unavailable")}</p>
      : data.commits.length === 0
        ? <p className="muted" style={{ padding: "32px 0" }}>{t("team.branch.empty")}</p>
        : <div className="commits">{data.commits.map(commit => <div key={`${commit.hash}:${commit.task}`} className="commit">
          <span className="node" aria-hidden="true" />
          <span className="commit-name">{names.get(commit.task) ?? commit.subject}</span>
          <span className="commit-meta"><span className="hash">{commit.hash}</span></span>
        </div>)}</div>}

    {data?.available && data.commits.length > 0 && <div className="line-tail" aria-hidden="true" />}

    <div className="merge" data-ready={possible ? "true" : "false"}>
      <h3 className="mono" style={{ fontSize: 14, fontWeight: 500 }}>{branch || t("team.branch.title")}</h3>
      <p>{possible ? t("team.merge.ready", { count: data?.commits.length ?? 0 })
        : outcome?.status === "merged" ? t("team.merge.done")
          : outcome?.code ? t(`team.merge.refused.${outcome.code}` as "team.merge.refused.merge_unavailable")
            : t("team.merge.openTasks", { count: open.length })}</p>
      {open.length > 0 && <p className="consequence" style={{ fontSize: 12, color: "var(--muted)", margin: 0 }}>
        {open.slice(0, 4).map(task => taskName(task, t)).join(" · ")}
      </p>}
      <button className="btn btn-primary" disabled={!possible || busy} onClick={async () => {
        if (!read || !possible) return;
        setBusy(true);
        try { setOutcome(await mergeBranch(request, read.runId, read.run.entityVersion)); } finally { setBusy(false); }
      }}>{t("team.merge.action")}</button>
    </div>
  </main>;
}