import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText } from "lucide-react";
import { parsePatch } from "./diff-model.js";

/**
 * Slice B — the one diff surface both the Workspace and the Reviews screen show.
 *
 * A changed-file rail on the left and the selected file's unified diff on the right. The numbers,
 * the hunk headers and the fills come from the patch text itself, so what the owner reads is what
 * the candidate wrote. Fills are subdued and every colour is a shell token, so both themes stay
 * readable rather than inverting into neon.
 */
export function DiffView({ patch, label, empty, initialPath }: {
  patch: string; label?: string; empty?: string; initialPath?: string;
}) {
  const { t } = useTranslation();
  const files = useMemo(() => parsePatch(patch), [patch]);
  const [chosen, setChosen] = useState<string | null>(null);
  const active = files.find(file => file.path === chosen) ?? files.find(file => file.path === initialPath) ?? files[0];

  if (files.length === 0) return <p className="team-muted" data-testid="diff-empty">{empty ?? t("diff.empty")}</p>;

  return <div className="ui-diff" data-testid="diff-view">
    <ul className="ui-diff-files" aria-label={t("web.changedFiles")}>
      {files.map(file => <li key={`${file.previousPath ?? ""}:${file.path}`}>
        <button type="button" aria-pressed={file === active} onClick={() => setChosen(file.path)} data-path={file.path} data-status={file.status}>
          <FileText aria-hidden="true" />
          <span className="ui-diff-path">
            <span>{file.path}</span>
            {file.previousPath && <small>{t("diff.renamedFrom")} {file.previousPath}</small>}
          </span>
          <span className="ui-diff-counts">
            {file.binary ? <small>{t("diff.binary")}</small> : <>
              <span data-count="added">+{file.added}</span><span data-count="removed">−{file.removed}</span>
            </>}
          </span>
        </button>
      </li>)}
    </ul>
    <section className="ui-diff-pane" aria-label={label ?? t("web.diff")}>
      {active && <header className="ui-diff-head">
        <code>{active.path}</code>
        <span className="ui-state" data-state={active.status}>{t(`diff.status.${active.status}`)}</span>
        {!active.binary && <span className="ui-diff-counts"><span data-count="added">+{active.added}</span><span data-count="removed">−{active.removed}</span></span>}
      </header>}
      {active?.binary ? <p className="team-muted" data-testid="diff-binary">{t("diff.binaryHint")}</p>
        : active && <div className="ui-diff-body">
          {active.hunks.map((hunk, index) => <div key={`${hunk.header}-${index}`} className="ui-hunk">
            <div className="ui-hunk-head">{hunk.header}</div>
            {hunk.lines.map((line, lineIndex) => <div key={lineIndex} className="ui-diff-line" data-kind={line.kind}>
              <span className="ui-ln" aria-hidden="true">{line.oldLine ?? ""}</span>
              <span className="ui-ln" aria-hidden="true">{line.newLine ?? ""}</span>
              <span className="ui-marker" aria-hidden="true">{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : line.kind === "note" ? "" : " "}</span>
              <span className="ui-code">{line.text || " "}</span>
            </div>)}
          </div>)}
          {active.hunks.length === 0 && !active.binary && <p className="team-muted">{t("diff.noHunks")}</p>}
        </div>}
    </section>
  </div>;
}
