import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { FileText, Folder } from "lucide-react";
import type { readManagedWorkspace } from "../../../../daemon/dist/routes/files.js";
import { Button } from "../../components/ui/button.js";
import { Card } from "../../components/ui/card.js";
import { useOwnerSession } from "../../hooks/useOwnerSession.js";

type Read = ReturnType<typeof readManagedWorkspace>;
export type BrowseState = { path: string; source: string };
export interface BrowseProps {
  runId: string; state: BrowseState; onState: (state: BrowseState) => void;
  tasks?: readonly { taskId: string }[];
}

export function WorkspaceView(props: BrowseProps) {
  return <WorkspaceBrowser {...props} view="workspace" />;
}

export function WorkspaceBrowser({ runId, state, onState, tasks, view }: BrowseProps & { view: "workspace" | "knowledge" }) {
  const { t } = useTranslation();
  const { paired, request } = useOwnerSession();
  const heading = useRef<HTMLHeadingElement>(null);
  const navigated = useRef(false);
  const source = state.source || (view === "knowledge" ? "target" : "");
  const query = useQuery({
    queryKey: ["team-browse", runId, view, source, state.path], enabled: paired && !!runId, retry: false,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ path: state.path });
      if (source) params.set(view === "knowledge" ? "root" : "taskId", source);
      return request<Read>(`/runs/${encodeURIComponent(runId)}/${view}?${params}`, { signal });
    },
  });
  const navigate = (next: BrowseState, moveFocus = true) => { navigated.current = moveFocus; onState(next); };
  useEffect(() => {
    if (navigated.current && !query.isFetching) { heading.current?.focus(); navigated.current = false; }
  }, [query.isFetching, state.path]);
  const read = query.data;
  return <Card className="team-card" data-testid={`team-${view}`}>
    <h2 className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--team-focus)] focus-visible:outline-offset-4" ref={heading} tabIndex={-1} style={{ outlineOffset: 4 }}>{t(`web.${view}`)}</h2>
    <p role="status">{t("web.readOnly")}</p>
    <div className="team-search">
      <label>{t(view === "knowledge" ? "web.knowledge" : "web.taskId")}
        <select value={source} onChange={e => navigate({ path: "", source: e.target.value }, false)}>
          {view === "knowledge" ? <><option value="target">{t("web.repository")}</option><option value="orchestrator">docs/</option></>
            : <><option value="">{t("web.repository")}</option>{tasks?.map(task => <option key={task.taskId} value={task.taskId}>{task.taskId}</option>)}</>}
        </select>
      </label>
      <p><code>{state.path || "/"}</code></p>
      <div className="team-filters">
        <Button variant="outline" aria-label={`${t(`web.${view}`)} /`} disabled={!state.path} onClick={() => navigate({ ...state, path: "" })}>/</Button>
        <Button variant="outline" aria-label={`${t(`web.${view}`)} ../`} disabled={!state.path} onClick={() => navigate({ ...state, path: state.path.split("/").slice(0, -1).join("/") })}>../</Button>
      </div>
    </div>
    {!paired ? <p role="status">{t("web.pairRequired")}</p> : !runId ? <p role="status">{t("web.noRun")}</p>
      : query.isError ? <p role="alert">{t("web.error")}: {t("value.unavailable")}</p>
      : query.isPending ? <p role="status">{t("web.loading")}</p>
      : read?.kind === "directory" ? <ul style={{ display: "grid", gap: 6, listStyle: "none", padding: 0 }}>
        {read.entries.length === 0 && <li>{t("value.unavailable")}</li>}
        {read.entries.map(entry => <li key={entry.name}><Button variant="outline" style={{ width: "100%", justifyContent: "flex-start", overflowWrap: "anywhere", minWidth: 44 }}
          onClick={() => navigate({ ...state, path: state.path ? `${state.path}/${entry.name}` : entry.name })}>
          {entry.kind === "directory" ? <Folder aria-hidden="true" /> : <FileText aria-hidden="true" />}<span>{entry.name}{entry.kind === "directory" ? "/" : ""}</span>
        </Button></li>)}
      </ul> : read && <>
        {"change" in read && <section aria-label={t("web.changes")}>
          <h3>{t("web.changes")}: <code>{({ created: "+", modified: "\u0394", deleted: "\u2212", unchanged: "=" } as Record<string, string>)[read.change]} {read.change === "created" ? t("team.create") : read.change === "modified" ? t("team.modify") : read.change}</code></h3>
          <h3>{t("web.snapshot")}</h3><p><code>{read.baseHash ?? "\u2205"}</code></p>
          <pre style={{ minHeight: 44 }} tabIndex={0} role="region" aria-label={t("web.snapshot")} className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--team-focus)]">{read.before ?? (read.baseHash === null ? "\u2205" : t("value.unavailable"))}</pre>
        </section>}
        <h3>{t("web.workspace")}</h3>
        {read.kind === "file" ? <><p><code>{read.hash}</code></p><pre style={{ minHeight: 44 }} tabIndex={0} role="region" aria-label={t(`web.${view}`)} className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--team-focus)]" data-testid="workspace-content">{read.content}</pre></> : <p>{"\u2205"}</p>}
      </>}
  </Card>;
}
