import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  TEAM_CONTROL_VERSION, TeamContractError, object, parseProtocolVersion, text, type ControlActor,
} from "../contracts/team-control.js";
import type { RigRepository } from "../domain/rig-repository.js";
import {
  TEAM_ROLES, TeamSetupError, createTeam, listTeams, parseTeamClient, type TeamSeatInput,
} from "../domain/team-setup.js";
import {
  teamControlAuthentication, type TeamControlCredentials, type TeamControlEnv,
} from "../middleware/auth-bearer-token.js";

/**
 * U3 — the owner's teams.
 *
 * One collection resource: `POST /teams` creates the rig and the seats a repository's team runs
 * on, and `GET /teams` lists the teams that exist so a client never asks the owner to type a rig
 * name. Both are owner-only and live on the team-control surface, so the managed-mode allowlist
 * and the owner credential apply unchanged.
 *
 * Nothing is launched here. Under `workers.isolation: none` the first start opens each seat's
 * terminal, exactly as it does for a rig the demo seeds created.
 */

export function teamSetupRoutes(
  rigRepo: RigRepository,
  options: { credentials: TeamControlCredentials },
  legacyTokens: readonly (string | null | undefined)[],
): Hono<TeamControlEnv> {
  const app = new Hono<TeamControlEnv>();
  app.use("*", teamControlAuthentication(() => options.credentials, legacyTokens));
  app.use("*", bodyLimit({ maxSize: 65_536,
    onError: c => c.json({ code: "invalid_team_contract", error: "The team request exceeds its size limit." }, 413) }));
  const owner = (c: { get: (key: "controlActor") => ControlActor }) =>
    c.get("controlActor").kind === "owner" ? c.get("controlActor") : null;

  app.get("/teams", (c) => {
    if (!owner(c)) return c.json({ code: "owner_control_required", error: "An authenticated owner read is required." }, 403);
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, teams: listTeams(rigRepo.db) });
  });

  app.post("/teams", async (c) => {
    if (!owner(c)) return c.json({ code: "owner_control_required", error: "An authenticated owner create is required." }, 403);
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    const v = object(await c.req.json(), "team");
    const repository = text(v.repository, "repository", 4096);
    // The daemon runs on the host the repository is on, and every seat's cwd is that path, so a
    // relative path would resolve against the daemon's own working directory instead.
    if (!repository.startsWith("/")) throw new TeamContractError("repository");
    const team = createTeam(rigRepo.db, { repository, seats: seats(v.seats),
      ...(v.name === undefined ? {} : { name: text(v.name, "name", 128) }) });
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, team }, 201);
  });

  app.onError((error, c) => {
    if (error instanceof TeamContractError || error instanceof SyntaxError) {
      return c.json({ code: "invalid_team_contract", error: "The team request is malformed or incompatible." }, 400);
    }
    if (error instanceof TeamSetupError) {
      const status = error.code === "team_exists" || error.code === "team_name_taken" ? 409 : 400;
      return c.json({ code: error.code, error: error.message }, status);
    }
    return c.json({ code: "team_creation_failed", error: "The team was not created." }, 500);
  });
  return app;
}

/** The seat list the request carries: at least one, each with a known role and client. */
function seats(value: unknown): TeamSeatInput[] {
  if (!Array.isArray(value) || !value.length) throw new TeamContractError("seats");
  return value.map(entry => {
    const v = object(entry, "seats");
    const role = text(v.role, "seats.role", 32);
    if (!(TEAM_ROLES as readonly string[]).includes(role)) throw new TeamContractError("seats.role");
    const client = parseTeamClient(text(v.client, "seats.client", 32));
    if (!client) throw new TeamContractError("seats.client");
    return { role: role as TeamSeatInput["role"], client,
      ...(v.model === undefined ? {} : { model: text(v.model, "seats.model", 128) }) };
  });
}
