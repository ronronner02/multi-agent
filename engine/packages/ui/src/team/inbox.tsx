import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { MessageKey } from "@multi-agent/i18n";
import { ArrowUpRight } from "lucide-react";
import { OwnerReadError, useOwnerSession } from "../hooks/useOwnerSession.js";
import { relativeTime } from "./display.js";
import {
  DISMISSABLE_STATES, STARTABLE_STATES, dismissIntakeItem, intakeKey, startIntakeItem, useIntake,
  type IntakeItem, type IntakeState,
} from "./intake.js";

const STATE_LABELS = {
  pending: "intake.state.pending", would_start: "intake.state.would_start", started: "intake.state.started",
  skipped: "intake.state.skipped", unavailable: "intake.state.unavailable", dismissed: "intake.state.dismissed",
} as const satisfies Record<IntakeState, MessageKey>;
const KIND_LABELS = { issue: "intake.kind.issue", comment: "intake.kind.comment", ci: "intake.kind.ci" } as const satisfies Record<IntakeItem["kind"], MessageKey>;

/** The run a started item opened; the same search parameter every run link uses. */
export function intakeRunHref(runId: string): string {
  return `/team/overview?${new URLSearchParams({ run: runId })}`;
}

/** U13 — the project inbox: what the intake policy saw, and what it did with it. */
export function InboxScreen({ teamId, onOpenRun }: { teamId?: string; onOpenRun: (runId: string) => void }) {
  const { t } = useTranslation(), { request } = useOwnerSession(), cache = useQueryClient();
  const intake = useIntake(teamId);
  const now = Date.now();
  const [busyItem, setBusyItem] = useState<string | null>(null);
  /** The daemon's reason for a refused Start or Dismiss, or "" when it gave none. */
  const [failed, setFailed] = useState<string | null>(null);
  const reply = intake.data;
  const replace = (item: IntakeItem) => cache.setQueryData(intakeKey(teamId ?? ""), { ...reply!,
    items: reply!.items.map(entry => entry.item === item.item ? item : entry) });
  const act = async (item: IntakeItem, action: "start" | "dismiss") => {
    if (!teamId || busyItem) return;
    setBusyItem(item.item); setFailed(null);
    try {
      if (action === "start") {
        const runId = await startIntakeItem(request, teamId, item.item);
        replace({ ...item, state: "started", runId });
      } else replace(await dismissIntakeItem(request, teamId, item.item));
    } catch (error) {
      setFailed(error instanceof OwnerReadError && error.error ? error.error : "");
      void intake.refetch();
    } finally { setBusyItem(null); }
  };
  return <main className="ui-screen ui-inbox">
    <header className="ui-page-head"><div><h1>{t("nav.inbox")}</h1></div>
      {reply?.repository && <span className="mono muted">{reply.repository}</span>}</header>
    {!teamId ? <p className="muted">{t("intake.noProject")}</p>
      : intake.isError ? <section className="ui-intake-status"><p role="alert">{t("intake.readFailed")}</p>
        <button className="btn btn-outline" onClick={() => void intake.refetch()}>{t("action.retry")}</button></section>
      : !reply ? <p className="muted" role="status">{t("web.loading")}</p>
        : reply.items.length === 0 ? <p className="muted">{t("intake.empty")}</p>
        : <section className="ui-intake-status" aria-label={t("nav.inbox")}><ul className="ui-intake-list">
          {reply.items.map(item => <li key={item.item} data-state={item.state} data-explicit={item.explicit}>
            <a className="ui-intake-open" href={item.url} target="_blank" rel="noopener noreferrer">
              <span className="ui-intake-kind">{t(KIND_LABELS[item.kind])}</span>
              <strong>{item.title}</strong>
              <ArrowUpRight aria-hidden="true" />
            </a>
            <p className="ui-intake-meta">
              <span>{item.author}</span><span aria-hidden="true">·</span>
              <span>{t(STATE_LABELS[item.state])}</span>
              {item.explicit && <span className="chip ui-intake-explicit">{t("intake.explicit")}</span>}
              {item.matched.length > 0 && <span>{item.matched.join(", ")}</span>}
              <span aria-hidden="true">·</span><span>{relativeTime(item.updatedAt, now, t)}</span>
            </p>
            <div className="ui-intake-actions">
              {STARTABLE_STATES.includes(item.state) && <button className="btn btn-primary" disabled={busyItem !== null}
                onClick={() => void act(item, "start")}>{t("intake.start")}</button>}
              {DISMISSABLE_STATES.includes(item.state) && <button className="btn btn-outline" disabled={busyItem !== null}
                onClick={() => void act(item, "dismiss")}>{t("intake.dismiss")}</button>}
              {item.state === "started" && item.runId && <a className="btn btn-outline" href={intakeRunHref(item.runId)}
                onClick={event => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault(); onOpenRun(item.runId!);
                }}>{t("intake.openRun")}</a>}
            </div>
          </li>)}
        </ul></section>}
    {failed !== null && <p role="alert">{failed || t("intake.actionFailed")}</p>}
  </main>;
}