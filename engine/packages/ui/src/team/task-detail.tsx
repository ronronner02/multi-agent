import { TaskEditControls } from "./task-edit/task-edit-dialog.js";
import { ResultPanel } from "./result-panel.js";
import type { TeamReviewView } from "@openrig/daemon/team-control";
import { useTranslation } from "react-i18next";
import { Card } from "../components/ui/card.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.js";

export function TaskDetail({ tab, onTab, task }: { tab: string; onTab: (value: string) => void; task?: TeamReviewView }) {
  const { t } = useTranslation();
  const runId = new URLSearchParams(window.location.search).get("run") ?? "";
  return <Card className="team-card team-task-detail" data-scroll-pane="task-detail" role="region" aria-label={t("web.taskDetail")}>
    <h2>{t("web.taskDetail")}</h2>
    {task && <p>{t(`role.${task.role}`)} · {t(`status.queue.${task.queueState}`)}</p>}
    <Tabs value={tab} onValueChange={onTab}><TabsList aria-label={t("web.taskDetail")}>
      {(["details", "discussion", "changes", "tests", "reviewRecord"] as const).map(tab =>
        <TabsTrigger key={tab} value={tab}>{t(`web.${tab}`)}</TabsTrigger>)}
    </TabsList>
    <TabsContent value="details" tabIndex={-1}>{task && runId && <TaskEditControls key={`${runId}:${task.taskId}`} runId={runId} taskId={task.taskId} />}<p><code>{task?.taskId ?? t("value.unavailable")}</code></p>
      <p>{t("web.candidate")}: <code>{task?.currentCandidateDigest ?? t("value.unavailable")}</code></p>
      <p>{t("web.progress")}: {task?.criteria.verified == null || task.criteria.total === null ? t("value.unavailable") : `${task.criteria.verified}/${task.criteria.total}`}</p>
      <dl className="team-detail-facts">{(["description", "criteria", "dependencies", "owners", "timestamps"] as const).map(field =>
        <div key={field}><dt>{t(`web.${field}`)}</dt><dd>{t("value.unavailable")}</dd></div>)}</dl>
      <p>{t("web.criteriaSource")}: <code>{task?.criteria.source ?? t("value.unavailable")}</code></p>
    </TabsContent>
    {(["discussion", "changes", "tests", "reviewRecord"] as const).map(tab => <TabsContent value={tab} key={tab}>
      <p>{t("web.readOnly")}</p>
      {tab === "tests" && task?.acceptance ? <><p>{t(task.acceptance.passed ? "web.acceptancePassed" : "web.acceptanceFailed")}</p><p>{task.acceptance.reason}</p><time>{task.acceptance.recordedAt}</time><p>{t("web.manifest")}: <code>{task.acceptance.manifestDigest}</code></p></> :
        tab === "reviewRecord" && task?.reviewAvailable ? <p>{t("web.reviewRounds")}: {task.rounds} · {t("web.openP0P1")}: {task.openP0P1}</p> : <p>{t("value.unavailable")}</p>}
    </TabsContent>)}
    </Tabs>
    {task && runId && <ResultPanel runId={runId} taskId={task.taskId} />}
  </Card>;
}
