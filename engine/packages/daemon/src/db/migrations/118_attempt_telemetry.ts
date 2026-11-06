import type { Migration } from "../migrate.js";

export const attemptTelemetrySchema: Migration = {
  name: "118_attempt_telemetry.sql",
  sql: `
    CREATE TABLE attempt_telemetry (
      attempt_id TEXT PRIMARY KEY REFERENCES team_attempts(id) ON DELETE CASCADE,
      native_session_id TEXT,
      native_usage_json TEXT CHECK (native_usage_json IS NULL OR json_valid(native_usage_json)),
      seat_name TEXT,
      started_at TEXT NOT NULL,
      stopped_at TEXT NOT NULL,
      active_ms INTEGER NOT NULL CHECK (active_ms >= 0),
      usage_json TEXT NOT NULL CHECK (json_valid(usage_json)),
      activity_json TEXT NOT NULL CHECK (json_valid(activity_json)),
      activity_status TEXT NOT NULL CHECK (activity_status IN ('available', 'partial', 'unavailable')),
      outcome TEXT NOT NULL DEFAULT 'unknown' CHECK (outcome IN ('succeeded', 'failed', 'canceled', 'unknown')),
      retry_scheduled INTEGER NOT NULL DEFAULT 0 CHECK (retry_scheduled IN (0, 1))
    );
    CREATE INDEX idx_attempt_telemetry_native_session ON attempt_telemetry(native_session_id);
    CREATE INDEX idx_attempt_telemetry_stopped ON attempt_telemetry(stopped_at);
  `,
};
