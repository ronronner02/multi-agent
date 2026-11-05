import { useTranslation } from "react-i18next";
import type { TeamOwnerRead } from "@openrig/daemon/team-control";
import { branchName, isFinished, relativeTime } from "./display.js";
import { useBranch } from "./hooks.js";

/**
 * U10 — the integration branch.
 *
 * The commits land in approval order on one branch, and the line runs into the merge plate at
 * its foot: the merge is the end of the line, not a button in a header. U7 publishes the branch
 * and performs the merge; until then the screen says so rather than drawing an empty list.
 */
export function BranchScreen({ read, runId, onBack }: { read?: TeamOwnerRead; runId: string; onBack: () => void }) {
  const { t } = useTranslation();
  const branch = useBranch(runId, !!read);
  const finished = (read?.tasks ?? []).length > 0 && (read?.tasks ?? []).every(isFinished);
  const name = branch.data?.branch || (read ? branchName(read.run.displayName) : "");
  const commits = branch.data?.commits ?? [];

  return <main className="branch">
    <div className="branch-head">
      <h1 className="display">{t("team.branch.title")}</h1>
      {name && <div className="branch-ref"><span>{name}</span><span className="arrow">→</span><span>{branch.data?.base ?? "main"}</span></div>}
    </div>

    {!branch.data?.available
      ? <p className="muted" style={{ padding: "32px 0" }}>{t("team.branch.unavailable")}</p>
      : commits.length === 0
        ? <p className="muted" style={{ padding: "32px 0" }}>{t("team.branch.empty")}</p>
        : <div className="commits">{commits.map(commit => <div key={`${commit.shortHash}:${commit.name}`} className="commit">
          <span className="node" aria-hidden="true" />
          <span className="commit-name">{commit.name}</span>
          <span className="commit-meta"><span className="hash">{commit.shortHash}</span> · {relativeTime(commit.committedAt, Date.now(), t)}</span>
        </div>)}</div>}

    {name && commits.length > 0 && <div className="line-tail" aria-hidden="true" />}
    <div className="merge" data-ready={finished && branch.data?.available ? "true" : "false"}>
      <h3>{t("team.merge.title", { branch: branch.data?.base ?? "main" })}</h3>
      <p>{branch.data?.available
        ? t("team.merge.ready", { count: commits.length })
        : t("team.merge.unavailable")}</p>
      <button className="btn btn-outline" disabled>{t("team.merge.action")}</button>
    </div>
  </main>;
}