import { readFileSync } from "node:fs";
import type { TeamRole } from "../contracts/team-control.js";

/**
 * The installed role configuration: each role's client and its permission vocabulary.
 *
 * Lives here rather than in `context-manifest.ts` because that module imports the
 * governance owner, and governance must validate a task's declared permissions against
 * this same vocabulary at creation. One file, one reader, no import cycle.
 */
export function immutable<T>(value: T): T {
  if (value !== null && typeof value === "object") { Object.values(value).forEach(immutable); Object.freeze(value); }
  return value;
}

export const roleConfiguration = immutable(JSON.parse(readFileSync(
  new URL("../../../../config/team/roles.json", import.meta.url), "utf8"))) as
  Record<TeamRole, { client: "claude-code" | "codex"; permissions: string[] }>;