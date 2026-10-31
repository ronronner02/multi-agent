/**
 * Boot the demo daemon in managed mode with the compiled stub runner in place of the native
 * client, so the whole start flow can be exercised without a provider account or a live
 * token. Prints the daemon's URL and blocks until killed.
 *
 * The stub command is the same one `unisolated-launch.test.ts` uses: the built entry, not the
 * TypeScript source, because the pane's working directory is the task's candidate worktree,
 * which has no `node_modules` for a loader flag to resolve from.
 *
 * Usage, from `engine/` after `npm run build`: npx tsx demo/team/scripts/demo-daemon.ts
 */
import { createServer } from "node:http";
import { join } from "node:path";
import { createDaemon } from "../../../packages/daemon/src/startup.js";
import { unisolatedWorkerRoots } from "../../../packages/daemon/src/domain/unisolated-roots.js";
import { unisolatedPolicyCapability } from "../../../packages/daemon/src/routes/team-start.js";

const PORT = Number(process.env.DEMO_PORT ?? 7433);
const HOME = process.env.OPENRIG_HOME ?? join(process.cwd(), ".demo-home");
const STUB_RUNNER = new URL("../../../packages/daemon/dist/adapters/stub-runner.js", import.meta.url).pathname;

async function main(): Promise<void> {
  const ownerToken = process.env.MULTI_AGENT_OWNER_TOKEN?.trim();
  if (!ownerToken) throw new Error("MULTI_AGENT_OWNER_TOKEN is required: the demo starts work as the owner.");
  process.env.OPENRIG_HOME = HOME;
  const policy = unisolatedPolicyCapability(unisolatedWorkerRoots(HOME).policyRevision);
  const daemon = await createDaemon({
    dbPath: process.env.OPENRIG_DB ?? ":memory:", managedMode: true,
    // The demo has one plan artifact per start request and no second source to reconcile it
    // against, so the run's own recorded binding is the current one.
    teamControl: { credentials: { ownerToken }, resolveBinding: run => run.binding, readPolicyCapability: () => policy },
    cmuxFactory: async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); },
    directLaunchCommand: facts => [process.execPath, STUB_RUNNER,
      "--session-name", facts.taskId, "--cwd", facts.tree, "--launch-id", facts.attemptId, "--posture", "floor"],
  });
  const server = createServer(async (request, response) => {
    const body = await new Promise<string>(resolve => { let data = ""; request.on("data", chunk => { data += chunk; });
      request.on("end", () => resolve(data)); });
    const answer = await daemon.app.fetch(new Request(new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`), {
      method: request.method, headers: request.headers as HeadersInit, ...(body ? { body } : {}) }),
    { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
    response.writeHead(answer.status, Object.fromEntries(answer.headers));
    response.end(Buffer.from(await answer.arrayBuffer()));
  });
  server.listen(PORT, "127.0.0.1", () => console.log(`demo daemon on http://127.0.0.1:${PORT}`));
  const stop = () => { server.close(); void daemon.deps.workflowRuntime?.closeManagedAttempts(); daemon.db.close(); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
}

main().catch(error => { console.error(error); process.exit(1); });
