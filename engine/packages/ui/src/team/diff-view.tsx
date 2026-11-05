import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { parsePatch } from "./diff-model.js";

/**
 * U10 — the task's diff.
 *
 * The file rail is a strip along the top so the code keeps the card's width; on a phone the
 * lines wrap with a hanging indent instead of being clipped, and the strip stays visible.
 * Numbers, hunk headers and fills all come from the patch text itself.
 */
export function DiffView({ patch, empty }: { patch: string; empty?: string }) {
  const { t } = useTranslation();
  const files = useMemo(() => parsePatch(patch), [patch]);
  const [chosen, setChosen] = useState<string | null>(null);
  const active = files.find(file => file.path === chosen) ?? files[0];

  if (files.length === 0) return <p className="muted" data-testid="diff-empty">{empty ?? t("team.task.noDiff")}</p>;

  return <div className="diff" data-testid="diff-view">
    <div className="files" role="group" aria-label={t("web.changedFiles")}>
      {files.map(file => <button key={`${file.previousPath ?? ""}:${file.path}`} type="button" className="file"
        aria-pressed={file === active} onClick={() => setChosen(file.path)} data-path={file.path}>
        <span>{file.path}</span>
        <span className="counts">
          {file.binary ? <span>{t("diff.binary")}</span>
            : <><span className="a">+{file.added}</span> <span className="d">−{file.removed}</span></>}
        </span>
      </button>)}
    </div>
    {active && <div className="code">
      <div className="code-head">{active.path}</div>
      {active.binary ? <p className="muted" style={{ padding: "12px 14px" }} data-testid="diff-binary">{t("diff.binaryHint")}</p>
        : <div className="code-body" data-testid="diff-body">
          {active.hunks.map((hunk, index) => <div key={`${hunk.header}-${index}`}>
            <div className="hunk-head">{hunk.header}</div>
            {hunk.lines.map((line, lineIndex) => <div key={lineIndex} className="cl" data-kind={line.kind === "context" ? undefined : line.kind}>
              <span className="ln" aria-hidden="true">{line.oldLine ?? ""}</span>
              <span className="ln" aria-hidden="true">{line.newLine ?? ""}</span>
              <span className="mark" aria-hidden="true">{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : line.kind === "note" ? "" : " "}</span>
              <span className="src">{line.text || " "}</span>
            </div>)}
          </div>)}
          {active.hunks.length === 0 && <p className="muted" style={{ padding: "12px 14px" }}>{t("diff.noHunks")}</p>}
        </div>}
    </div>}
  </div>;
}