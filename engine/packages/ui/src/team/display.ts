import type { TFunction } from "i18next";
import type { TeamQueueState, TeamReviewView, TeamSeatView, TeamTaskNameParts, TeamTaskStage } from "@multi-agent/daemon/team-control";

/**
 * U10 — how the team surface names things.
 *
 * Every name the owner reads comes from here. The run, task and seat names are the U9 display
 * names; a reviewer task is rebuilt from its parts so the word "Review" is the reader's
 * language, not the stored English one. Ids stay in URLs and React keys and never reach the DOM.
 */

export function taskName(task: Pick<TeamReviewView, "displayName" | "displayNameParts">, t: TFunction): string {
  return nameFromParts(task.displayNameParts, task.displayName, t);
}

export function nameFromParts(parts: TeamTaskNameParts, fallback: string, t: TFunction): string {
  if (parts.kind !== "review") return fallback;
  return parts.round > 1
    ? t("team.reviewNameRound", { round: parts.round, of: parts.of })
    : t("team.reviewName", { of: parts.of });
}

/** The five states the line and the task header use. */
export type TeamStateWord = "queued" | "running" | "reviewing" | "done" | "blocked" | "canceled";

export function stateOf(task: Pick<TeamReviewView, "queueState" | "role">): TeamStateWord {
  const state: TeamQueueState = task.queueState;
  switch (state) {
    case "done":
    case "handed-off":
      return "done";
    case "in-progress":
      return task.role === "reviewer" ? "reviewing" : "running";
    case "blocked":
    case "failed":
    case "denied":
      return "blocked";
    case "canceled":
      return "canceled";
    default:
      return "queued";
  }
}

export function stateLabel(state: TeamStateWord, t: TFunction): string {
  return t(`team.state.${state}` as "team.state.done");
}

/** A task is finished when the queue says so; the merge gate and the line both read this. */
export function isFinished(task: Pick<TeamReviewView, "queueState">): boolean {
  return task.queueState === "done" || task.queueState === "handed-off";
}

export function clientLabel(client: string, t: TFunction): string {
  return client === "codex" ? t("team.client.codex") : client === "claude-code" ? t("team.client.claude-code") : client;
}

/**
 * The seat a task of this role runs on. The read publishes the rig's seats but not the seat a
 * task was routed to, so a role with one seat names its client and a role with several names
 * the role alone rather than guessing which one ran.
 */
export function seatLabel(role: TeamReviewView["role"], seats: readonly TeamSeatView[], t: TFunction): string {
  const matching = seats.filter(seat => seat.role === role);
  const roleName = t(`role.${role}` as "role.lead");
  if (matching.length !== 1) return roleName;
  return `${roleName} · ${clientLabel(matching[0]!.client, t)}`;
}

export function runStateWord(teams: { running: boolean }, t: TFunction): string {
  return teams.running ? t("team.teams.running") : t("team.teams.idle");
}

/** "刚刚 / 3 分钟前 / 昨天 22:06" — relative inside a day, then a date. */
export function relativeTime(iso: string, now: number, t: TFunction): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return t("team.time.now");
  if (minutes < 60) return t("team.time.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  const date = new Date(at);
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const sameDay = new Date(now).toDateString() === date.toDateString();
  if (sameDay) return t("team.time.hours", { count: hours });
  const yesterday = new Date(now - 86_400_000).toDateString() === date.toDateString();
  return yesterday ? t("team.time.yesterday", { time: clock }) : clock;
}

export function clockTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The branch a run delivers to: `team/<slug>` from the run's own name. Display only. */
export function branchName(displayName: string): string {
  const slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "run";
  return `team/${slug}`;
}

/**
 * The daemon's branch name carries a short suffix of the run id so two runs with the same goal
 * cannot collide. That suffix is an internal id, so the screen shows the readable part; the
 * name itself is unchanged wherever git needs the real one.
 */
export function readableBranch(branch: string): string {
  return branch.replace(/-[0-9a-f]{8}(-[0-9a-f]{4})*$/i, "").replace(/-+$/, "");
}

export const TASK_STAGE_LABELS = {
  "owner/decision": "tasks.stage.owner", "owner/question": "tasks.stage.owner", "owner/blocked": "tasks.stage.owner",
  "lead/report": "tasks.stage.lead", queued: "tasks.column.pending", running: "tasks.column.in-progress",
  review: "progress.review", done: "team.state.done",
} as const satisfies Record<TeamTaskStage, string>;

export function namedSeat(seat: TeamSeatView, t: TFunction): string {
  return t(("role." + seat.role) as "role.lead") + " · " + clientLabel(seat.client, t)
    + (seat.index === null ? "" : " " + seat.index);
}

export function assignedSeat(task: TeamReviewView, seats: readonly TeamSeatView[], t: TFunction): string {
  const seat = seats.find(item => item.seat === task.seat);
  return seat ? namedSeat(seat, t) : t(("role." + task.role) as "role.lead");
}
