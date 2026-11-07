import type { TeamRole, TeamTaskAuthority } from "../contracts/team-control.js";
import { LEAD_ESCALATION_PATH, LEAD_PROPOSAL_PATH } from "./lead-proposal.js";
import { leadRosterPath } from "./lead-roster.js";

/**
 * MVP — the completion path's evidence half.
 *
 * The owner's outcome command needs evidence, and the owner cannot read a worker's tree: the
 * daemon can. This module states, from the candidate the runtime already computes for
 * `rig team apply` and the diff view, what the daemon can check for itself. `validated` is a
 * derived fact, never a caller's claim, which is R18 read literally: an attempt that ended, or a
 * candidate that exists, is not by itself evidence the work was done where it was allowed.
 */

/** What the daemon could verify about a task's candidate, as the owner action records it. */
export interface TaskCompletionEvidence {
  /** True only when every check below passed. The C2 loop reads exactly this field. */
  validated: boolean;
  manifestDigest: string | null;
  base: "commit" | "snapshot" | null;
  baseIdentifier: string | null;
  /** How many files the candidate's manifest holds, so the owner sees its size, not only its hash. */
  fileCount: number;
  /** The paths the candidate moves, read from the candidate's own patch. */
  changedPaths: string[];
  /** Changed paths the assignment does not cover. Any entry makes `validated` false. */
  outsideAssignment: string[];
  /** Why `validated` is false, in the daemon's own words. Empty exactly when it is true. */
  reasons: string[];
}

/** The manifest the runtime serves, narrowed to the fields the evidence reads. */
export interface CandidateFacts {
  base: "commit" | "snapshot";
  baseIdentifier: string;
  files: ReadonlyArray<{ path: string }>;
  manifestDigest: string;
  patch: string;
}

/**
 * The paths a unified diff moves, from its own headers.
 *
 * The patch is the candidate's own computation — the same bytes `rig team apply` replays — so
 * this reads the deliverable rather than walking the tree a second time.
 */
export function changedPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split("\n")) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (match) paths.push(match[2]!);
  }
  return paths;
}

const covers = (path: string, paths: readonly string[]) =>
  paths.some(owned => path === owned || path.startsWith(owned + "/"));

/**
 * What the daemon can state about one task's candidate.
 *
 * `manifest` is `null` when the runtime holds no readable candidate for the task: an attempt
 * that never launched, a tree the control could not adopt, or one already released. That is
 * reported as its own reason instead of as an empty candidate, because the two mean different
 * things to the owner.
 */
export function taskCompletionEvidence(input: {
  role: TeamRole;
  assignmentPaths: readonly string[];
  manifest: CandidateFacts | null;
  unavailableReason?: string;
}): TaskCompletionEvidence {
  const empty: TaskCompletionEvidence = { validated: false, manifestDigest: null, base: null, baseIdentifier: null,
    fileCount: 0, changedPaths: [], outsideAssignment: [], reasons: [] };
  if (!input.manifest) {
    return { ...empty, reasons: [input.unavailableReason ?? "The task's candidate could not be read"] };
  }
  const { manifest } = input;
  const paths = changedPaths(manifest.patch);
  const outside = paths.filter(path => !covers(path, input.assignmentPaths));
  const reasons: string[] = [];
  // The snapshot lane has no base commit to diff, so the daemon cannot say what moved. A
  // reviewer's candidate is the implementer's tree, which this reads the same way.
  if (manifest.base === "snapshot") reasons.push("The candidate has no base commit to diff against");
  if (manifest.base === "commit" && paths.length === 0) reasons.push("The candidate moves no path");
  if (outside.length) reasons.push(`${outside.length} changed path(s) fall outside the assignment`);
  return { validated: reasons.length === 0, manifestDigest: manifest.manifestDigest, base: manifest.base,
    baseIdentifier: manifest.baseIdentifier, fileCount: manifest.files.length, changedPaths: paths,
    outsideAssignment: outside, reasons };
}

/**
 * C3 — what a lead's candidate is evidence of.
 *
 * A lead's deliverable is its decomposition, not a code change: its assignment paths are the
 * run's scope, which is what its proposed tasks must stay inside, and its one output is
 * `lead-proposal.json` at the root of its own tree. Applying the implementer rule would call
 * that file outside the assignment and refuse every lead completion, so the role gets its own:
 * the candidate is validated exactly when the only path it moves is the proposal and that file
 * is a decomposition the boundary would accept.
 *
 * `proposal` is the daemon's own reading of that file, through the same boundary every other
 * worker-written file goes through. `null` means the read failed or the file was not there,
 * which is reported as its own reason rather than as an empty candidate.
 */
export function leadCompletionEvidence(input: {
  manifest: CandidateFacts | null;
  proposal: { taskCount: number } | null;
  /**
   * U6 — the escalation the turn asked the owner for, or null when it asked for none.
   *
   * Present (even as null) means this caller reads a delivery lead's escalations, and turns on
   * the manager rule below. Absent keeps C3's rule exactly: the turn's one deliverable is the
   * proposal, and a turn without it is not validated.
   */
  escalation?: { optionCount: number } | null;
  /**
   * U6 — a delivery lead turn is a management turn, not a decomposition.
   *
   * Its management files are the proposal and the escalation, and a turn that wrote neither is
   * still a turn the owner asked for: the daemon woke it for a team event and its answer is its
   * message in the chat. What stays invalid is a turn that moved anything else, or wrote one of
   * its two files in a shape the boundary refuses.
   */
  managementTurn?: boolean;
  planRef?: string;
  unavailableReason?: string;
}): TaskCompletionEvidence {
  const empty: TaskCompletionEvidence = { validated: false, manifestDigest: null, base: null, baseIdentifier: null,
    fileCount: 0, changedPaths: [], outsideAssignment: [], reasons: [] };
  if (!input.manifest) {
    return { ...empty, reasons: [input.unavailableReason ?? "The task's candidate could not be read"] };
  }
  const { manifest } = input;
  const paths = changedPaths(manifest.patch);
  const reasons: string[] = [];
  if (manifest.base === "snapshot") reasons.push("The candidate has no base commit to diff against");
  const wroteProposal = paths.includes(LEAD_PROPOSAL_PATH);
  const wroteEscalation = paths.includes(LEAD_ESCALATION_PATH);
  // Everything but the lead's own management files is a write it has no permission for. Each is
  // reported as outside the assignment so the owner sees what moved, exactly as an
  // implementer's is.
  const outside = paths.filter(path => path !== LEAD_PROPOSAL_PATH
    && !(input.managementTurn === true && (path === LEAD_ESCALATION_PATH || path === leadRosterPath(input.planRef ?? "plan.md"))));
  if (outside.length) reasons.push(`${outside.length} changed path(s) are not the lead's proposal`);
  if (input.managementTurn === true) {
    // A management turn delivers whatever it was asked for. A proposal the boundary refuses is
    // not a turn that failed its evidence: the manager reads it, refuses it, and hands the reason
    // to the lead as its next prompt (U6). Counting it as invalid evidence instead would spend a
    // retry on a recoverable refusal, and the lead would be retried without being told why. Only
    // an escalation is checked here, because an escalation the owner cannot answer is silence.
    if (wroteEscalation && (input.escalation ?? null) === null) reasons.push("The lead's escalation is missing or unreadable");
  } else {
    if (manifest.base === "commit" && !wroteProposal) {
      reasons.push(`The candidate does not write ${LEAD_PROPOSAL_PATH}`);
    }
    if (input.proposal === null) reasons.push("The lead's proposal is missing or unreadable");
  }
  return { validated: reasons.length === 0, manifestDigest: manifest.manifestDigest, base: manifest.base,
    baseIdentifier: manifest.baseIdentifier, fileCount: manifest.files.length, changedPaths: paths,
    outsideAssignment: outside, reasons };
}

/**
 * The task whose candidate a task's evidence describes.
 *
 * A reviewer task owns no tree: its assignment's `reviewOf` names the implementer task whose
 * candidate it was admitted to read, so the evidence the owner records for a review is that
 * candidate's. Every other role is its own subject.
 */
export function evidenceSubject(task: Pick<TeamTaskAuthority, "assignment">, taskId: string): string {
  return task.assignment.role === "reviewer" && task.assignment.reviewOf !== undefined
    ? task.assignment.reviewOf : taskId;
}

/** The attempt an outcome may be recorded against: the task's latest, stopped, with an identity. */
export interface CompletionAttempt {
  attemptId: string;
  entityVersion: number;
  state: string;
  observed: boolean;
}

/**
 * Whether the owner's action can be recorded now, and if not, why.
 *
 * These are the same preconditions `recordTaskOutcome` enforces, stated early so the UI shows
 * one sentence instead of a refusal the owner has to decode. The command still re-checks them
 * inside its transaction; this is a read, never an authority.
 */
export function completionBlockedReason(input: {
  queueState: string | null;
  attempt: CompletionAttempt | null;
  openAttempts: number;
  actorSession: string | null;
}): string | null {
  if (!input.queueState) return "The task has no queue row";
  if (!["pending", "in-progress", "blocked"].includes(input.queueState)) return "The task already has a terminal outcome";
  if (!input.attempt) return "The task has no recorded attempt yet";
  if (input.attempt.state !== "stopped" || !input.attempt.observed) return "The attempt has not been observed to stop";
  if (input.openAttempts > 0) return "Another attempt of this task is still unresolved";
  if (!input.actorSession) return "The task's seat is not recorded";
  return null;
}
