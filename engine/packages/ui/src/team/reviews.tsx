import { useTranslation } from "react-i18next";
import type { TeamOwnerRead, TeamReviewView } from "@openrig/daemon/team-control";
import type { IntegrationState } from "./clients.js";
import { taskName } from "./display.js";
import { TaskChanges } from "./workspace/workspace-focus.js";

type GateState = "passed" | "waiting" | "unknown";
type GateKey = "evidence" | "review" | "integration" | "merge";

/** Missing evidence and a verdict for another candidate never become a pass. */
export function reviewGates(task: TeamReviewView | undefined, integration: IntegrationState | undefined): Array<{ key: GateKey; state: GateState }> {
  const latest = task?.verdicts.at(-1);
  const current = !!task?.currentCandidateDigest && latest?.candidateDigest === task.currentCandidateDigest;
  const reviewed = !!task?.reviewAvailable && current && latest?.verdict === "approved" && latest.blocking === 0;
  const integrated = reviewed && integration?.commits.some(commit => commit.task === task!.taskId);
  const knownCriteria = !!task && task.criteria.verified !== null && task.criteria.total !== null;
  return [
    { key: "evidence", state: !knownCriteria ? "unknown" : task.criteria.verified === task.criteria.total ? "passed" : "waiting" },
    { key: "review", state: !task?.reviewAvailable || !latest ? "unknown" : reviewed ? "passed" : "waiting" },
    { key: "integration", state: !task || !integration?.available ? "unknown" : integrated ? "passed" : "waiting" },
    { key: "merge", state: !task || !integration?.available ? "unknown" : integrated && integration.merge.possible ? "passed" : "waiting" },
  ];
}

function Findings({ task }: { task?: TeamReviewView }) {
  const { t } = useTranslation();
  const latest = task?.verdicts.at(-1);
  if (!task?.reviewAvailable || !latest) return <p className="ui-muted">{t("reviews.noFindings")}</p>;
  return <>
    <p className="ui-review-round">{t("reviews.roundLabel", { round: latest.round })}<span>
      {t(latest.verdict === "approved" ? "reviews.verdictApproved" : "reviews.verdictChangesRequired")}</span></p>
    {(!task.currentCandidateDigest || latest.candidateDigest !== task.currentCandidateDigest)
      && <p className="ui-muted">{t("reviews.staleCandidate")}</p>}
    {latest.findingRecords.length === 0 ? <p className="ui-muted">{t("reviews.emptyRound")}</p>
      : <ul className="ui-findings">{latest.findingRecords.map(finding => <li key={finding.id}>
        <span className="ui-finding-severity" data-severity={finding.severity}>{finding.severity}</span>
        <div><code>{finding.file}</code><p>{finding.summary}</p></div>
      </li>)}</ul>}
    <details><summary>{t("reviews.recordDetails")}</summary><dl className="ui-technical-details">
      <dt>{t("reviews.candidateDigest")}</dt><dd>{latest.candidateDigest ?? "—"}</dd>
      <dt>{t("reviews.findings")}</dt><dd>{latest.findingRecords.map(finding => finding.id).join(", ") || "—"}</dd>
    </dl></details>
  </>;
}

export function ReviewsScreen({ read, selectedTaskId, integration, onSelect, onAskLead }: {
  read?: TeamOwnerRead; selectedTaskId: string; integration?: IntegrationState;
  onSelect: (taskId: string) => void; onAskLead: (task: TeamReviewView, opener: HTMLButtonElement) => void;
}) {
  const { t } = useTranslation();
  const tasks = read?.tasks.filter(task => task.role !== "reviewer") ?? [];
  const task = tasks.find(task => task.taskId === selectedTaskId)
    ?? tasks.find(task => task.currentCandidateDigest) ?? tasks[0];
  return <main className="ui-screen ui-reviews">
    <header className="ui-page-head">
      <div><h1>{t("nav.reviews")}</h1><p className="ui-subtitle">{t("reviews.subtitle")}</p></div>
      {task && <button className="btn btn-outline" onClick={event => onAskLead(task, event.currentTarget)}>{t("reviews.askLead")}</button>}
    </header>
    {task && <label className="ui-review-select">{t("reviews.task")}
      <select value={task.taskId} onChange={event => onSelect(event.target.value)}>
        {tasks.map(item => <option key={item.taskId} value={item.taskId}>{taskName(item, t)}</option>)}
      </select>
    </label>}
    <div className="ui-reviews-body">
      <section className="ui-card ui-reviews-main" aria-label={t("reviews.candidate")}>
        <h2>{task ? taskName(task, t) : t("reviews.candidate")}</h2>
        <TaskChanges runId={read?.runId ?? ""} task={task} />
      </section>
      <aside className="ui-reviews-inspector" aria-label={t("reviews.inspector")}>
        <section className="ui-card" aria-label={t("reviews.findings")}>
          <h2>{t("reviews.findings")}{task?.reviewAvailable && <span className="ui-count">{task.verdicts.at(-1)?.findingRecords.length ?? 0}</span>}</h2>
          <Findings task={task} />
        </section>
        <section className="ui-card" aria-label={t("reviews.gates")}>
          <h2>{t("reviews.gates")}</h2>
          <ul className="ui-gates">{reviewGates(task, integration).map(gate => <li key={gate.key} data-gate={gate.key} data-state={gate.state}>
            <span className="ui-dot" aria-hidden="true" /><span>{t(("reviews.gate." + gate.key) as "reviews.gate.evidence")}</span>
            <span>{t(("reviews.gateState." + gate.state) as "reviews.gateState.passed")}</span>
          </li>)}</ul>
        </section>
      </aside>
    </div>
  </main>;
}
