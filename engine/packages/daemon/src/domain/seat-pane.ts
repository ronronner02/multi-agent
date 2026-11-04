import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { NodeWithBinding } from "./types.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { observeSolePane } from "./pane-binding-observation.js";

/**
 * MVP — the seat's terminal when `workers.isolation: none`.
 *
 * A fresh install never runs `rig up`, so a managed task can name a seat that has rows and no
 * terminal at all: `start-team-demo.ts` registers the session, and the direct launcher's seat
 * resolution needs a tmux binding to type into. Under hardened isolation that absence is a
 * refusal, because the privileged launcher must never invent a surface it did not observe.
 * Under `none` the daemon is the only authority over the seat, so the one owner of "where does
 * this seat live" opens the terminal itself: a detached session named for the seat, started in
 * the node's cwd, on the daemon's own tmux server. The pane is then recorded the way every other
 * binding is recorded, and the launch resolves it unchanged.
 */

export const SEAT_UNRESOLVED = "direct_launch_seat_unresolved";

export interface SeatPaneDependencies {
  rigRepo: Pick<RigRepository, "getRig">;
  sessions: Pick<SessionRegistry, "db" | "findResumeContextByName" | "getLatestLiveSessions" | "updateBinding">;
  tmux: Pick<TmuxAdapter, "createSession" | "listPanes" | "deliveryGuard">;
  /** The environment a launched seat's shell gets, exactly as `NodeLauncher` gives it. */
  sessionEnv?: Record<string, string | undefined>;
  runtimeSessionEnv?: Record<string, Record<string, string | undefined>>;
}

/**
 * The pane a seat's task launches into, creating the seat's terminal when it has none.
 *
 * A pane already bound and live is returned as it stands. Otherwise the terminal is created,
 * and tmux's own answer to that is the existence test: a session already holding this name is
 * a refusal, never a surface to adopt, so an existing terminal is never replaced. Creating one
 * is a lifecycle change, so it runs under the same seat lease `NodeLauncher` takes — a
 * managed-mode daemon refuses a terminal mutation that no lease owns.
 */
export async function ensureSeatPane(dependencies: SeatPaneDependencies, sessionName: string): Promise<string> {
  const seat = resolveSeat(dependencies, sessionName);
  const bound = await liveBoundPane(dependencies.tmux, seat.node, sessionName);
  if (bound) return bound;
  const guard = dependencies.tmux.deliveryGuard;
  return guard && !guard.ownsLifecycle(seat.node.id)
    ? guard.lifecycle([seat.node.id], () => ensureSeatPane(dependencies, sessionName))
    : createSeatSession(dependencies, sessionName);
}

/** The seat the address resolves to: one live session, its node with its binding, and a usable cwd. */
function resolveSeat(dependencies: SeatPaneDependencies, sessionName: string): { node: NodeWithBinding } {
  const { rigRepo, sessions } = dependencies;
  const session = sessions.findResumeContextByName(sessionName);
  const live = session ? sessions.getLatestLiveSessions(session.rigId).filter(entry => entry.sessionName === sessionName) : [];
  const node = session ? rigRepo.getRig(session.rigId)?.nodes.find(entry => entry.id === session.nodeId) : undefined;
  if (!session || live.length !== 1 || live[0]!.sessionId !== session.sessionId || live[0]!.nodeId !== session.nodeId
    || !node?.cwd) throw new Error(SEAT_UNRESOLVED);
  return { node };
}

/** The recorded pane, while tmux still reports it as this session's pane. */
async function liveBoundPane(tmux: SeatPaneDependencies["tmux"], node: NodeWithBinding, sessionName: string): Promise<string | null> {
  const bound = node.binding;
  if (bound?.attachmentType !== "tmux" || bound.tmuxSession !== sessionName || !/^%[0-9]+$/.test(bound.tmuxPane ?? "")) return null;
  return (await tmux.listPanes(sessionName)).some(pane => pane.id === bound.tmuxPane) ? bound.tmuxPane! : null;
}

/** Open the seat's terminal and record the pane it made. Runs under the seat's lifecycle lease. */
async function createSeatSession(dependencies: SeatPaneDependencies, sessionName: string): Promise<string> {
  const { sessions, tmux } = dependencies;
  // Re-read under the lease: another launch may have opened this seat's terminal meanwhile.
  const seat = resolveSeat(dependencies, sessionName);
  const bound = await liveBoundPane(tmux, seat.node, sessionName);
  if (bound) return bound;
  const created = await tmux.createSession(sessionName, seat.node.cwd!, seatEnv(dependencies, seat.node, sessionName));
  // A name already taken is another terminal, not this seat's, so it is refused rather than
  // adopted. Any other refusal likewise leaves no pane, and the launch refuses with it.
  if (!created.ok) throw new Error(SEAT_UNRESOLVED);
  const observed = await observeSolePane(tmux, sessionName);
  if (!observed.ok) throw new Error(SEAT_UNRESOLVED);
  // MVP — a pane id is only unique within one tmux server's lifetime. When the last client exits,
  // tmux stops its server, and the next server numbers its panes from `%0` again. A binding left
  // on a dead seat therefore names the *new* seat's pane, and every reader that resolves a seat
  // by pane id — the delivery guard's target lookup among them — finds two candidates and refuses
  // the launch. The binding belongs to the pane that was just created, so any other node still
  // claiming this exact pane is stale by construction and is released before this one is written.
  sessions.db.prepare("UPDATE bindings SET tmux_pane = NULL WHERE tmux_pane = ? AND node_id <> ?")
    .run(observed.pane, seat.node.id);
  sessions.updateBinding(seat.node.id, { attachmentType: "tmux", tmuxSession: sessionName, tmuxPane: observed.pane });
  // The seat's guard target is its binding, so the lease that opened this terminal now owns
  // the new one; without this the next input would refuse as a changed target.
  tmux.deliveryGuard?.rebindLifecycle(seat.node.id);
  return observed.pane;
}

/** The seat's shell environment, mirroring the one a launched seat receives. */
function seatEnv(dependencies: SeatPaneDependencies, node: NodeWithBinding, sessionName: string): Record<string, string> {
  const env: Record<string, string> = {};
  const source = { ...dependencies.sessionEnv, ...(node.runtime ? dependencies.runtimeSessionEnv?.[node.runtime] : undefined),
    OPENRIG_NODE_ID: node.id, OPENRIG_SESSION_NAME: sessionName, OPENRIG_RUNTIME: node.runtime ?? undefined };
  for (const [key, value] of Object.entries(source)) if (typeof value === "string" && value.length > 0) env[key] = value;
  return env;
}

/** The seat a task routes to, as the queue recorded it. Exactly one, or the caller refuses. */
export function seatForTask(sessions: Pick<SessionRegistry, "db">, runId: string, taskId: string): string {
  const rows = sessions.db.prepare(`
    SELECT q.destination_session AS sessionName
    FROM team_queue_authority a JOIN queue_items q ON q.qitem_id = a.qitem_id
    WHERE a.run_id = ? AND a.task_id = ? LIMIT 2`).all(runId, taskId) as Array<{ sessionName: string }>;
  if (rows.length !== 1 || !rows[0]!.sessionName) throw new Error(SEAT_UNRESOLVED);
  return rows[0]!.sessionName;
}
