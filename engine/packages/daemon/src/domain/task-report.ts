import { object, TeamContractError } from "../contracts/team-control.js";

export interface TaskReport {
  status: "blocked" | "needs-decision" | "dropped";
  question?: string;
  evidence: string;
  /**
   * U4 — the attempt that wrote this report, when the worker named one.
   *
   * Completion requires the report's attempt id to match the current attempt, so a report left
   * in the per-attempt directory by an earlier generation cannot describe a later one. The
   * supervisor clears the directory before spawn, but a worker that writes this field gives
   * the daemon a second, durable witness. Absent means the worker wrote none, which is the
   * shape the contract has always accepted.
   */
  attemptId?: string;
}

/** Worker-written prose is bounded data, not a task or source-permission change. */
export function parseTaskReport(value: unknown): TaskReport {
  const report = object(value, "taskReport");
  if (Object.keys(report).some(key => !["status", "question", "evidence", "attemptId"].includes(key))) throw new TeamContractError("taskReport");
  if (!["blocked", "needs-decision", "dropped"].includes(report.status as string)) throw new TeamContractError("taskReport.status");
  const prose = (value: unknown, field: string, limit: number): string => {
    if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\u0000")) throw new TeamContractError(field);
    return value;
  };
  return { status: report.status as TaskReport["status"],
    ...(report.question === undefined ? {} : { question: prose(report.question, "taskReport.question", 500) }),
    ...(report.attemptId === undefined ? {} : { attemptId: prose(report.attemptId, "taskReport.attemptId", 256) }),
    evidence: prose(report.evidence, "taskReport.evidence", 16_384) };
}

export function unreadableTaskReport(error: unknown): TaskReport {
  const reason = error instanceof Error ? error.message : "Unknown read error";
  return { status: "blocked", question: ("Task report could not be read: " + reason).slice(0, 500),
    evidence: "The daemon did not accept this attempt's task-report.json." };
}
