import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Folder } from "lucide-react";
import { useOwnerSession } from "../hooks/useOwnerSession.js";

interface Directories { roots: string[]; path: string | null; directories: Array<{ name: string; path: string }> }

/**
 * The parent folder of a path the daemon reported, or null when it has none.
 *
 * R15 — the browser is shared with a Windows daemon, so the separator is whichever one the
 * reported path actually uses. Splitting on `/` alone would make every `C:\Users\…` path look
 * like a single segment with no parent, and the Up button would disappear.
 */
export function parentFolder(path: string): string | null {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (separator < 0) return null;
  const parent = path.slice(0, separator);
  // A drive root keeps its separator (`C:\`), and so does a POSIX root (`/`).
  if (parent === "" || /^[A-Za-z]:$/.test(parent)) return parent + path[separator];
  return parent;
}

export function FolderBrowser({ onSelect, onCancel }: { onSelect: (path: string) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const { paired, request } = useOwnerSession();
  const [path, setPath] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["team", "directories", path], enabled: paired, retry: false,
    queryFn: ({ signal }) => request<Directories>("/fs/dirs" + (path ? "?path=" + encodeURIComponent(path) : ""), { signal }) });
  const current = query.data?.path;
  const atRoot = !!current && query.data?.roots.includes(current);
  const up = current ? (atRoot ? null : parentFolder(current)) : null;
  return <section className="ui-folder-browser" aria-label={t("projects.browseFolders")}>
    <div className="ui-folder-navigation">
      <button className="btn btn-quiet" type="button" onClick={() => setPath(null)}>{t("projects.locations")}</button>
      <button className="btn btn-quiet" type="button" disabled={!current} onClick={() => setPath(up)}><ArrowLeft aria-hidden="true" />{t("projects.up")}</button>
    </div>
    <p className="mono ui-folder-path">{current ?? t("projects.chooseLocation")}</p>
    {query.isError ? <><p role="alert">{t("projects.folderReadFailed")}</p>
      <button className="btn btn-outline" type="button" onClick={() => void query.refetch()}>{t("github.retry")}</button></>
      : query.isPending ? <p role="status">{t("web.loading")}</p>
        : <ul className="ui-folder-list">{query.data?.directories.map(directory => <li key={directory.path}>
          <button type="button" onClick={() => setPath(directory.path)}><Folder aria-hidden="true" /><span>{directory.name}</span></button>
        </li>)}</ul>}
    <div className="plate-foot">
      <button className="btn btn-outline" type="button" onClick={onCancel}>{t("projects.back")}</button>
      <button className="btn btn-primary" type="button" disabled={!current || atRoot || query.isError || query.isFetching}
        onClick={() => { if (current) onSelect(current); }}>{t("projects.useFolder")}</button>
    </div>
  </section>;
}
