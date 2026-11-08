import type { Migration } from "../migrate.js";

export const teamModelPolicySchema: Migration = {
  name: "119_team_model_policy.sql",
  sql: `
    ALTER TABLE rigs ADD COLUMN team_model_allowlist TEXT
      CHECK (team_model_allowlist IS NULL OR json_valid(team_model_allowlist));
    ALTER TABLE rigs ADD COLUMN team_kind TEXT NOT NULL DEFAULT 'project'
      CHECK (team_kind IN ('project', 'test'));
  `,
};
