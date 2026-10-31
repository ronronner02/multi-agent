// The terminal UI was retired on 2026-10-31; the team dashboard is the Web UI.
// The verb stays so existing instructions do not hit "unknown command", names the
// Web UI, and exits non-zero so no script reads it as a successful open.
import { Command } from "commander";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";

export interface TuiDeps {
  lifecycleDeps: LifecycleDeps;
}

export const TUI_RETIRED_MESSAGE =
  "The OpenRig terminal UI was retired. The team dashboard is the Web UI:";

export function tuiCommand(depsOverride?: TuiDeps): Command {
  return new Command("tui")
    .description("retired: prints the Web UI dashboard URL and exits non-zero")
    .addHelpText("after", "\nThe terminal UI no longer ships. The team dashboard is the Web UI served by the daemon at <daemon-url>/team.\n")
    .action(async () => {
      const status = await getDaemonStatus((depsOverride ?? { lifecycleDeps: realDeps() }).lifecycleDeps, { cleanupStaleState: false });
      console.error(TUI_RETIRED_MESSAGE);
      // Without a running daemon there is no live URL to read; the default target is still the one it will serve.
      console.error(`  ${status.port === undefined ? "http://127.0.0.1:7433/team" : `${getDaemonUrl(status)}/team`}`);
      process.exitCode = 1;
    });
}
