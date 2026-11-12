import { useTranslation } from "react-i18next";
import { TextPreview } from "./text-preview.js";
import type { MessageKey } from "@multi-agent/i18n";
import type { RunSummary, TeamSummary } from "./hooks.js";

export function ProjectHome({ team, runs, section, onOpenRun, onDiscuss, onModels }: {
  team: TeamSummary; runs: RunSummary[]; section: "overview" | "documents" | "workspace" | "tasks" | "reviews";
  onOpenRun: (runId: string, section: "overview" | "documents" | "workspace" | "tasks" | "reviews") => void;
  onDiscuss: (opener: HTMLButtonElement) => void; onModels: () => void;
}) {
  const { t } = useTranslation();
  const planning = runs.filter(run => run.phase === "planning"), execution = runs.filter(run => run.phase !== "planning");
  const results = execution.filter(run => (run.resultCount ?? 0) > 0);
  const hasLead = team.seats.some(seat => seat.role === "lead");
  const group = (title: MessageKey, entries: RunSummary[], empty: MessageKey, target = section) => <section className="plate ui-history-group" aria-label={t(title)}>
    <h2>{t(title)} <span className="muted" aria-hidden="true">{entries.length}</span></h2>
    {entries.length === 0 ? <p className="muted">{t(empty)}</p> : <ul>{entries.map(run => <li key={run.id}>
      <button className="ui-history-open" onClick={() => onOpenRun(run.id, target)}><strong>{run.displayName}</strong>
        <span className="muted">{t(run.phase === "planning" ? "planning.mode" : "execution.mode")} · {t(`status.run.${run.state}`)}</span>
        <span className="muted">{t("records.messageCount", { count: run.messageCount ?? 0 })} · {t("records.taskCount", { count: run.executionTaskCount ?? 0 })} · {t("records.resultCount", { count: run.resultCount ?? 0 })}</span>
      </button></li>)}</ul>}
  </section>;
  return <div className="page">
    <header className="ui-page-head"><div><h1 className="display" aria-label={section === "overview" ? team.name : undefined}>
      {section === "overview" ? <TextPreview text={team.name} /> : t(`nav.${section}`)}</h1>
      <span className="chip">{t(team.kind === "test" ? "records.testProject" : "records.project")}</span>
      {section === "overview" && <p className="mono muted ui-project-path"><TextPreview text={team.repository} /></p>}</div>
      <div className="ui-project-actions"><button className="btn btn-outline" onClick={onModels}>{t("models.title")}</button>
        {hasLead && <button className="btn btn-primary" onClick={event => onDiscuss(event.currentTarget)}>{t("planning.discuss")}</button>}</div>
    </header>
    {section !== "overview" && <p className="muted">{t(section === "tasks" && execution.length > 0 ? "records.chooseExecution" : `records.empty.${section}`)}</p>}
    {(section === "overview" || section === "workspace" || section === "documents") && group("records.planning", planning, "records.noPlanning", section === "documents" ? "documents" : "overview")}
    {section !== "reviews" && group("records.execution", execution, "records.noExecution")}
    {(section === "overview" || section === "reviews") && group("records.results", results, "records.noResults", "reviews")}
  </div>;
}
