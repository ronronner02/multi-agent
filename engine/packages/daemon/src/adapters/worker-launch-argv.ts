import { agentTurnOutputPaths } from "../domain/agent-turn.js";
import type { WorkerClient } from "./worker-launch.js";

/**
 * U3 — the frozen worker launch argv, one row per client, posture and continuation.
 *
 * This is the contract the plan pins: fresh and continuation, implementer and reviewer, for both
 * clients. It was carried here verbatim from the pane launcher that used to own it, because the
 * flags are not incidental — each one is why a managed turn is watchable, resumable and confined:
 *
 * - **Claude** runs one headless turn (`-p`). `stream-json --verbose` is the only mode the
 *   installed build streams in, and `--include-partial-messages` is what makes a turn readable
 *   while it runs. An implementer gets `bypassPermissions` (native Windows has no sandbox, so
 *   this is the documented light-isolation posture); a reviewer gets `plan` and the read tools,
 *   which is the read-only posture the plan requires.
 * - **Codex** runs `exec` (or `exec resume`), `--json`, and `-o <last-message>` so the turn's
 *   answer lands in the one file every reader knows. An implementer gets `workspace-write`, the
 *   report directory as its only writable root, and network access; a reviewer gets `read-only`
 *   with `approval_policy=never` and no writable roots.
 * - **A continuation** keeps the conversation: Claude replaces `--session-id` with `--resume`,
 *   and Codex prefixes `resume`, sets the sandbox through the config flag (0.160.0 refuses
 *   `-C`/`-s` on `resume`), and appends the session id.
 * - **The trailing `-`** is Codex's stdin marker; Claude's `-p` already reads its prompt from
 *   stdin, so neither client is ever handed its prompt on the command line.
 */

export interface WorkerArgvInput {
  client: WorkerClient;
  /** The admitted candidate tree; the child's working directory. */
  tree: string;
  /** The turn's durable output directory, for `-o`, the report root and the thread id. */
  output: ReturnType<typeof agentTurnOutputPaths>;
  readOnly: boolean;
  /** The assignment's role, which decides Codex's writable roots. */
  role: string;
  /** The conversation this turn opens or continues. */
  sessionId: string;
  /** True when this attempt continues a recorded conversation rather than opening one. */
  continuing: boolean;
  model?: string;
  effort?: string;
}

/** The argv for one managed turn, after the executable. */
export function workerArgv(input: WorkerArgvInput): string[] {
  if (input.client === "claude-code") {
    return ["-p", "--permission-mode", input.readOnly ? "plan" : "bypassPermissions",
      "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      ...(input.readOnly ? ["--tools", "Read,Glob,Grep", "--strict-mcp-config"] : []),
      ...(input.model ? ["--model", input.model] : []), ...(input.effort ? ["--effort", input.effort] : []),
      ...(input.continuing ? ["--resume", input.sessionId] : ["--session-id", input.sessionId])];
  }
  const sandbox = input.readOnly ? "read-only" : "workspace-write";
  return ["exec", ...(input.continuing ? ["resume"] : []), "--json", "-o", input.output.lastMessage,
    ...(input.continuing ? ["-c", "sandbox_mode=" + sandbox] : ["-C", input.tree, "-s", sandbox]),
    ...(input.readOnly ? ["-c", "approval_policy=never"] : ["-c", "sandbox_workspace_write.network_access=true"]),
    "-c", "check_for_update_on_startup=false",
    ...(!input.readOnly && ["implementer", "reviewer"].includes(input.role)
      ? ["-c", "sandbox_workspace_write.writable_roots=" + JSON.stringify([input.output.taskReport])] : []),
    ...(input.model ? ["-m", input.model] : []), ...(input.effort ? ["-c", "model_reasoning_effort=" + input.effort] : []),
    ...(input.continuing ? [input.sessionId] : []), "-"];
}
