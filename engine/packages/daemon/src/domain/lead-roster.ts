import { posix } from "node:path";
import { object, text, TeamContractError, type PlanBinding } from "../contracts/team-control.js";
import { modelId } from "./team-model-policy.js";
import type { TeamClient } from "./team-setup.js";
import { soulId } from "./team-souls.js";

export const LEAD_ROSTER_PATH = "lead-roster.json";
export interface LeadRosterSeat { role: "implementer" | "reviewer"; client: TeamClient; model?: string; soulId?: string }
export interface LeadRosterEvidence { seats: LeadRosterSeat[]; digest: string }

export function leadRosterPath(planRef: string): string {
  return posix.join(posix.dirname(planRef), LEAD_ROSTER_PATH);
}

/** The planning write scope records whether this run started with a lead-built roster. */
export function planningRosterRequired(binding: PlanBinding): boolean {
  return binding.writePaths.includes(leadRosterPath(binding.planRef));
}

export function parseRosterSeats(value: unknown): LeadRosterSeat[] {
  if (!Array.isArray(value)) throw new TeamContractError("roster.seats");
  return value.map(entry => {
    const seat = object(entry, "roster.seat");
    if (Object.keys(seat).some(key => !["role", "client", "model", "soulId"].includes(key))
      || (seat.role !== "implementer" && seat.role !== "reviewer")
      || (seat.client !== "claude-code" && seat.client !== "codex")) throw new TeamContractError("roster.seat");
    return { role: seat.role, client: seat.client, ...(seat.model === undefined ? {} : { model: modelId(seat.model) }),
      ...(seat.soulId === undefined ? {} : { soulId: soulId(seat.soulId) }) };
  });
}

export function rosterRefusal(seats: readonly LeadRosterSeat[], maxSeats: number): string | null {
  if (!seats.some(seat => seat.role === "implementer")) return "The roster needs at least one implementer.";
  if (seats.filter(seat => seat.role === "reviewer").length > 1) return "The roster has more than one reviewer.";
  if (seats.length > maxSeats) return `The roster exceeds team.maxSeats (${maxSeats}, excluding the lead).`;
  return null;
}

export function parseLeadRoster(value: unknown): LeadRosterSeat[] {
  const roster = object(value, "roster");
  if (Object.keys(roster).some(key => key !== "seats")) throw new TeamContractError("roster");
  const seats = parseRosterSeats(roster.seats);
  const refusal = rosterRefusal(seats, Number.MAX_SAFE_INTEGER);
  if (refusal) throw new Error(refusal);
  return seats;
}

export interface LeadSeatChanges { add: LeadRosterSeat[]; retire: string[] }

export function parseLeadSeatChanges(value: unknown): LeadSeatChanges {
  const changes = object(value, "proposal.seats");
  if (Object.keys(changes).some(key => key !== "add" && key !== "retire")) throw new TeamContractError("proposal.seats");
  const add = parseRosterSeats(changes.add === undefined ? [] : changes.add);
  const rawRetire = changes.retire === undefined ? [] : changes.retire;
  if (!Array.isArray(rawRetire)) throw new TeamContractError("proposal.seats.retire");
  const retire = rawRetire.map(value => text(value, "proposal.seats.retire", 256));
  if (new Set(retire).size !== retire.length) throw new TeamContractError("proposal.seats.retire");
  return { add, retire };
}
