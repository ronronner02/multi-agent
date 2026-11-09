import type { Migration } from "../migrate.js";

export const replyLanguageSchema: Migration = {
  name: "122_reply_language.sql",
  sql: `ALTER TABLE team_chat_messages ADD COLUMN response_language TEXT
    CHECK (response_language IS NULL OR response_language IN ('en', 'zh-CN'));
    ALTER TABLE team_runs ADD COLUMN response_language TEXT
    CHECK (response_language IS NULL OR response_language IN ('en', 'zh-CN'));`,
};
