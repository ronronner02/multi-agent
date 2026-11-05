import { useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import type { TeamRole } from "@openrig/daemon/team-control";
import { OwnerReadError, useOwnerSession } from "../hooks/useOwnerSession.js";
import { isRunActive } from "./clients.js";
import { clientLabel } from "./display.js";
import { NewWorkSheet } from "./new-task.js";
import { Caret, Close } from "./glyphs.js";
import { runsKey, teamsKey, type RunSummary, type TeamSeatSummary, type TeamSummary } from "./hooks.js";

/**
 * U10 — the owner's teams.
 *
 * One row per repository, with the seats it runs and the state of its latest run. The create
 * sheet writes through U3's `POST /teams`, and a refusal is shown as the daemon's own reason,
 * mapped onto the field that caused it.
 */

const ROLES: readonly TeamRole[] = ["lead", "implementer", "reviewer"];
const CLIENTS = ["claude-code", "codex"] as const;

export function TeamsScreen({ teams, runs, loading, onOpenTeam, onOpenRun }: {
  teams: TeamSummary[] | undefined; runs: RunSummary[] | undefined; loading: boolean;
  onOpenTeam: (teamId: string) => void; onOpenRun: (runId: string) => void;
}) {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const [newWorkFor, setNewWorkFor] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  return <div className="page" ref={host}>
    <div className="page-head">
      <h1 className="display">{t("team.teams.title")}</h1>
      <button className="btn btn-primary" onClick={() => setCreating(true)}>{t("team.teams.new")}</button>
    </div>

    {loading && !teams ? <p className="muted">{t("value.unavailable")}</p>
      : (teams ?? []).length === 0
        ? <p className="muted">{t("team.teams.empty")}</p>
        : <div className="team-list">{teams!.map(team => {
          const run = (runs ?? []).find(entry => entry.rigId === team.id);
          return <div key={team.id} className="team-row">
            <a className="team-main" href="#" onClick={event => { event.preventDefault(); onOpenTeam(team.id); }}>
              <div><span className="team-name">{team.name}</span><span className="team-path">{team.repository}</span></div>
              <div className="seats">{team.seats.map((seat, index) => <SeatChip key={`${seat.role}:${index}`} seat={seat} />)}</div>
            </a>
            <div className="team-side">
              <div className="team-run" data-state={run && isRunActive(run) ? "running" : "idle"}>
                <span className="run-dot" />{run && isRunActive(run) ? t("team.teams.running") : t("team.teams.idle")}
              </div>
              <button className="btn btn-outline team-new-work" onClick={() => setNewWorkFor(team.id)}>{t("team.teams.newWork")}</button>
            </div>
          </div>;
        })}</div>}

    <CreateTeamSheet open={creating} onOpenChange={setCreating} container={host.current} />
    <NewWorkSheet teams={teams} teamId={newWorkFor ?? ""} open={newWorkFor !== null}
      onOpenChange={next => { if (!next) setNewWorkFor(null); }} onStarted={onOpenRun} />
  </div>;
}

function SeatChip({ seat }: { seat: TeamSeatSummary }) {
  const { t } = useTranslation();
  return <span className="chip" data-role={seat.role}>
    <i />{t(`role.${seat.role}` as "role.lead")} · {clientLabel(seat.client, t)}
  </span>;
}

interface DraftSeat { role: TeamRole; client: (typeof CLIENTS)[number] }

function CreateTeamSheet({ open, onOpenChange, container }: {
  open: boolean; onOpenChange: (open: boolean) => void; container: HTMLElement | null;
}) {
  const { t } = useTranslation();
  const session = useOwnerSession();
  const cache = useQueryClient();
  const [repository, setRepository] = useState("");
  const [draft, setDraft] = useState<DraftSeat[]>([
    { role: "lead", client: "claude-code" },
    { role: "implementer", client: "claude-code" },
    { role: "reviewer", client: "codex" },
  ]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const reset = () => { setRepository(""); setFailure(null); setBusy(false); };
  const errorText = useMemo(() => {
    if (!failure) return null;
    const key = `team.error.${failure}` as "team.error.generic";
    const text = t(key);
    return text === key || !text ? t("team.error.generic") : text;
  }, [failure, t]);

  const submit = async () => {
    if (busy || !repository.trim() || !draft.length) return;
    setBusy(true); setFailure(null);
    try {
      await session.request("/teams", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repository: repository.trim(), seats: draft }) });
      await cache.invalidateQueries({ queryKey: teamsKey });
      await cache.invalidateQueries({ queryKey: runsKey });
      onOpenChange(false);
      reset();
    } catch (error) {
      setFailure(error instanceof OwnerReadError ? error.code : "generic");
    } finally { setBusy(false); }
  };

  return <Dialog.Root open={open} onOpenChange={next => { onOpenChange(next); if (!next) reset(); }}>
    <Dialog.Portal container={container ?? undefined}>
      <Dialog.Overlay className="scrim" />
      <Dialog.Content className="sheet" aria-label={t("team.create.title")}>
        <header className="sheet-head">
          <Dialog.Title className="display" style={{ fontSize: 20, margin: 0 }}>{t("team.create.title")}</Dialog.Title>
          <Dialog.Close className="more" aria-label={t("team.create.close")}><Close /></Dialog.Close>
        </header>
        <div className="sheet-body">
          <div className="field">
            <label htmlFor="team-repository">{t("team.create.repository")}</label>
            <input id="team-repository" className="input mono" value={repository} spellCheck={false}
              onChange={event => setRepository(event.target.value)} placeholder="/home/you/src/project" />
          </div>
          <div className="field">
            <label>{t("team.create.seats")}</label>
            {draft.map((seat, index) => <div className="seat-row" key={index}>
              <label className="input select">
                <span className="sr-only">{t("team.create.seats")}</span>
                <select value={seat.role} onChange={event => setDraft(rows => rows.map((row, at) =>
                  at === index ? { ...row, role: event.target.value as TeamRole } : row))}>
                  {ROLES.map(role => <option key={role} value={role}>{t(`role.${role}` as "role.lead")}</option>)}
                </select>
                <Caret />
              </label>
              <label className="input select">
                <span className="sr-only">{t("team.settings.title")}</span>
                <select value={seat.client} onChange={event => setDraft(rows => rows.map((row, at) =>
                  at === index ? { ...row, client: event.target.value as DraftSeat["client"] } : row))}>
                  {CLIENTS.map(client => <option key={client} value={client}>{clientLabel(client, t)}</option>)}
                </select>
                <Caret />
              </label>
              <button className="remove" aria-label={t("team.create.removeSeat")} onClick={() =>
                setDraft(rows => rows.filter((_, at) => at !== index))}><Close /></button>
            </div>)}
            <button className="add-seat" onClick={() => setDraft(rows => [...rows, { role: "implementer", client: "codex" }])}>
              + {t("team.create.addSeat")}
            </button>
          </div>
          {errorText && <p role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>{errorText}</p>}
        </div>
        <footer className="sheet-foot">
          <button className="btn btn-primary" style={{ flex: 1 }} disabled={busy || !repository.trim() || !draft.length}
            onClick={() => void submit()}>{t("team.create.submit")}</button>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}