import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TeamTaskResult } from "@openrig/daemon/team-control";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { useOwnerSession } from "../hooks/useOwnerSession.js";

/**
 * MVP slice 3 — the finished task's result, as the owner receives it.
 *
 * The daemon serves the candidate's own patch; this panel shows what it moves and the command
 * that applies it. A later slice replaces this with an editor-style diff, so it stays plain:
 * the changed files, the unified diff in monospace, and the command to copy.
 *
 * Nothing here applies the patch. Applying writes into a repository the browser cannot see, so
 * the owner runs `rig team apply` in the checkout — the panel hands them the exact command.
 */
export function ResultPanel({ runId, taskId }: { runId: string; taskId?: string }) {
  const { t } = useTranslation();
  const { paired, request } = useOwnerSession();
  const result = useQuery({
    queryKey: ["team", runId, "result", taskId ?? ""],
    enabled: paired && !!runId && !!taskId, retry: false,
    queryFn: async ({ signal }) => {
      const { result: value } = await request<{ result: TeamTaskResult }>(
        `/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId!)}/result`, { signal });
      if (value.schema !== "multi-agent-team-result/v1" || value.runId !== runId || value.taskId !== taskId) {
        throw new Error("invalid_team_result");
      }
      return value;
    },
  });
  const command = `rig team apply ${runId} --task ${taskId ?? ""}`.trim();
  return <Card className="team-card" role="region" aria-label={t("web.result")}>
    <h2>{t("web.result")}</h2>
    {!taskId || result.isPending ? <p className="team-muted">{t("web.resultPending")}</p>
      : result.isError ? <p className="team-muted">{t("web.resultUnavailable")}</p>
      : <ResultBody value={result.data} command={command} />}
  </Card>;
}

/** The paths a unified diff moves, read from its own headers rather than a second manifest. */
export function changedPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split("\n")) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (match) paths.push(match[2]!);
  }
  return paths;
}

function ResultBody({ value, command }: { value: TeamTaskResult; command: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const files = changedPaths(value.patch);
  return <>
    <p className="team-muted">{t("web.candidate")}: <code>{value.manifestDigest}</code></p>
    <h3>{t("web.changedFiles")}</h3>
    {files.length ? <ul>{files.map(path => <li key={path}><code>{path}</code></li>)}</ul> : <p>{t("web.resultUnavailable")}</p>}
    <h3>{t("web.diff")}</h3>
    <pre>{value.patch || t("web.resultUnavailable")}</pre>
    <h3>{t("web.applyCommand")}</h3>
    <p><code>{command}</code> <Button variant="outline" onClick={async () => {
      try { await navigator.clipboard.writeText(command); setCopied(true); } catch { setCopied(false); }
    }}>{t("web.copy")}</Button>{copied && <span role="status">{t("web.copy")}</span>}</p>
  </>;
}
