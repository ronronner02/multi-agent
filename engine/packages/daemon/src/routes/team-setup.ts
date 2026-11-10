import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  TEAM_CONTROL_VERSION, TeamContractError, absolutePath, object, parseProtocolVersion, text, type ControlActor,
} from "../contracts/team-control.js";
import { readTeamModelSettings, saveTeamModelSettings, TeamModelError } from "../domain/team-model-policy.js";
import { nativeModelChoices } from "../domain/native-model-choices.js";
import { FRAMEWORK_CATALOG, FRAMEWORK_PIN } from "../integrations/framework/catalog.js";
import { assignSeatSoul, saveTeamSoul, soulId, teamSoulSettings, TeamSoulError } from "../domain/team-souls.js";
import type { RigRepository } from "../domain/rig-repository.js";
import { bootstrapProject, listProjectDirectories, previewProject, ProjectBootstrapError } from "../domain/project-bootstrap.js";
import { GithubCliError, type GithubCli } from "../domain/github-cli.js";
import type { SettingsStore } from "../domain/user-settings/settings-store.js";
import {
  TEAM_ROLES, TeamSetupError, availableTeamName, canonicalTeamRepository, createTeam, listTeams, parseTeamClient, type TeamSeatInput,
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
  options: { credentials: TeamControlCredentials; github: GithubCli; settingsStore?: SettingsStore },
  legacyTokens: readonly (string | null | undefined)[],
): Hono<TeamControlEnv> {
  const app = new Hono<TeamControlEnv>();
  app.use("*", teamControlAuthentication(() => options.credentials, legacyTokens));
  app.use("/teams/*", bodyLimit({ maxSize: 65_536,
    onError: c => c.json({ code: "invalid_team_contract", error: "The team request exceeds its size limit." }, 413) }));
  const owner = (c: { get: (key: "controlActor") => ControlActor }) =>
    c.get("controlActor").kind === "owner" ? c.get("controlActor") : null;

  app.get("/fs/dirs", c => {
    if (!owner(c)) return c.json({ code: "owner_control_required", error: "An authenticated owner read is required." }, 403);
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    c.header("Cache-Control", "no-store");
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, ...listProjectDirectories(c.req.query("path")) });
  });

  app.get("/teams", (c) => {
    if (!owner(c)) return c.json({ code: "owner_control_required", error: "An authenticated owner read is required." }, 403);
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, teams: listTeams(rigRepo.db) });
  });
  app.get("/workflows", c => {
    if (!owner(c)) return c.json({ code: "owner_control_required", error: "An authenticated owner read is required." }, 403);
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    c.header("Cache-Control", "no-store");
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, revision: FRAMEWORK_PIN.revision, workflows: FRAMEWORK_CATALOG });
  });

  app.get("/teams/:teamId/settings", c => {
    if (!owner(c)) return c.json({ code: "owner_control_required", error: "An authenticated owner read is required." }, 403);
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    c.header("Cache-Control", "no-store");
    const settings = readTeamModelSettings(rigRepo.db, c.req.param("teamId"));
    const saved = [...(settings.lead.model ? [{ client: settings.lead.client, model: settings.lead.model }] : []),
      ...(settings.allowedSubagents ?? [])];
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, settings, modelChoices: nativeModelChoices({ saved }) });
  });
  app.get("/teams/:teamId/souls", c => {
    if (!owner(c)) return c.json({ code: "owner_control_required", error: "An authenticated owner read is required." }, 403);
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    c.header("Cache-Control", "no-store");
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, ...teamSoulSettings(rigRepo.db, c.req.param("teamId")) });
  });
  app.put("/teams/:teamId/souls/:soulId", async c => {
    if (!owner(c)) return c.json({ code: "owner_control_required", error: "An authenticated owner update is required." }, 403);
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    c.header("Cache-Control", "no-store");
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION,
      profile: saveTeamSoul(rigRepo.db, c.req.param("teamId"), c.req.param("soulId"), await c.req.json()) });
  });
  app.put("/teams/:teamId/seats/:nodeId/soul", async c => {
    if (!owner(c)) return c.json({ code: "owner_control_required", error: "An authenticated owner update is required." }, 403);
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    assignSeatSoul(rigRepo.db, c.req.param("teamId"), c.req.param("nodeId"), await c.req.json());
    c.header("Cache-Control", "no-store");
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, ...teamSoulSettings(rigRepo.db, c.req.param("teamId")) });
  });
  app.put("/teams/:teamId/settings", async c => {
    if (!owner(c)) return c.json({ code: "owner_control_required", error: "An authenticated owner update is required." }, 403);
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    c.header("Cache-Control", "no-store");
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, settings: saveTeamModelSettings(rigRepo.db, c.req.param("teamId"), await c.req.json()) });
  });

  app.post("/teams", async (c) => {
    if (!owner(c)) return c.json({ code: "owner_control_required", error: "An authenticated owner create is required." }, 403);
    parseProtocolVersion(c.req.header("X-Team-Control-Version") ?? TEAM_CONTROL_VERSION);
    const v = object(await c.req.json(), "team");
    const repository = text(v.repository, "repository", 4096);
    // The daemon runs on the host the repository is on, and every seat's cwd is that path, so a
    // relative path would resolve against the daemon's own working directory instead. R15 — an
    // absolute path is one this host can use, which on Windows means a drive or UNC root, not
    // only a leading `/`.
    absolutePath(repository, "repository");
    if (v.dryRun !== undefined && typeof v.dryRun !== "boolean") throw new TeamContractError("dryRun");
    if (v.openExisting !== undefined && typeof v.openExisting !== "boolean") throw new TeamContractError("openExisting");
    c.header("Cache-Control", "no-store");
    if (v.openExisting === true) {
      if (v.seats !== undefined) throw new TeamContractError("openExisting");
      const root = canonicalTeamRepository(repository);
      const name = availableTeamName(rigRepo.db, root, v.name === undefined ? undefined : text(v.name, "name", 100));
      if (v.dryRun === true) return c.json({ protocolVersion: TEAM_CONTROL_VERSION,
        preview: { repository: root, name, action: "open", fileCount: 0, excludedPaths: [] } });
      const configured = options.settingsStore?.resolveOne("team.leadClient").value ?? "claude-code";
      const leadClient = typeof configured === "string" ? parseTeamClient(configured) : null;
      if (!leadClient) throw new TeamSetupError("team_seats_invalid", "Set the lead client to claude-code or codex before opening a project.");
      const team = createTeam(rigRepo.db, { repository: root, name, seats: [{ role: "lead", client: leadClient }] });
      return c.json({ protocolVersion: TEAM_CONTROL_VERSION, team }, 201);
    }
    if (v.seats === undefined) {
      const input = { repository, name: text(v.name, "name", 100) };
      if (v.dryRun === true) return c.json({ protocolVersion: TEAM_CONTROL_VERSION,
        preview: await previewProject(input, undefined, rigRepo.db) });
      const configured = options.settingsStore?.resolveOne("team.leadClient").value ?? "claude-code";
      const leadClient = typeof configured === "string" ? parseTeamClient(configured) : null;
      if (!leadClient) throw new TeamSetupError("team_seats_invalid", "Set the lead client to claude-code or codex before creating a project.");
      const team = await bootstrapProject(rigRepo.db, input, { github: options.github, leadClient });
      return c.json({ protocolVersion: TEAM_CONTROL_VERSION, team }, 201);
    }
    if (v.dryRun === true) throw new TeamContractError("dryRun");
    const team = createTeam(rigRepo.db, { repository, seats: seats(v.seats),
      ...(v.name === undefined ? {} : { name: text(v.name, "name", 128) }) });
    return c.json({ protocolVersion: TEAM_CONTROL_VERSION, team }, 201);
  });

  app.onError((error, c) => {
    if (error instanceof TeamContractError || error instanceof SyntaxError) {
      return c.json({ code: "invalid_team_contract", error: "The team request is malformed or incompatible." }, 400);
    }
    if (error instanceof TeamModelError) return c.json({ code: error.code, error: error.message }, error.status);
    if (error instanceof TeamSoulError) return c.json({ code: error.code, error: error.message }, error.status);
    if (error instanceof TeamSetupError) {
      const status = error.code === "team_exists" || error.code === "team_name_taken" ? 409 : 400;
      return c.json({ code: error.code, error: error.message }, status);
    }
    if (error instanceof ProjectBootstrapError) {
      const status = error.code === "team_origin_changed" || error.code === "team_bootstrap_changed" ? 409 : 400;
      return c.json({ code: error.code, error: error.message, excludedPaths: error.excludedPaths,
        ...(error.oversizedPaths.length ? { oversizedPaths: error.oversizedPaths } : {}) }, status);
    }
    if (error instanceof GithubCliError) {
      const status = error.code === "github_repo_exists" || error.code === "github_not_signed_in" ? 409
        : error.code === "github_cli_missing" ? 503 : 502;
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
      ...(v.model === undefined ? {} : { model: text(v.model, "seats.model", 128) }),
      ...(v.soulId === undefined ? {} : { soulId: soulId(v.soulId) }) };
  });
}
