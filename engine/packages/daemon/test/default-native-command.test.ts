import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createDaemon } from "../src/startup.js";
import { hashBinding, hashBytes } from "../src/domain/plan-governance.js";
import { unisolatedPolicyCapability } from "../src/routes/team-start.js";
import { unisolatedWorkerRoots } from "../src/domain/unisolated-roots.js";
import type { PlanBinding } from "../src/contracts/team-control.js";

/**
 * U3 — the default launch resolves the client through the shared resolver, not through a shell.
 *
 * The launcher no longer types a command line into a pane, so the question this case answers
 * changed with the transport: with no override at all, does the daemon find the real client on
 * its own PATH and start it as a child? A fixture client is put first on PATH, records the argv
 * it was given, and then fails as a missing client would — so nothing paid runs and the turn's
 * failure is still classifiable.
 *
 * This test exercises the full daemon pipeline including the mailbox bridge, which requires
 * AF_UNIX sockets. On Windows, the environment skips tests that depend on the mailbox bridge;
 * the frozen argv contract is verified on POSIX by the direct-worker-launch test's daemon
 * integration sweep case.
 */
describe.skipIf(process.platform === "win32")("default native command", () => {

function writable(path: string): void {
  chmodSync(path, 0o755);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) writable(child);
    else chmodSync(child, 0o644);
  }
}

it.each([
  ["claude-code", "claude", "--permission-mode"],
  ["codex", "codex", "exec"],
] as const)("starts the default %s client found on PATH with no launch override", async (runtime, executable, firstFlag) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "default-native-command-")));
  const home = join(directory, "home"), repo = join(directory, "repo"), bin = join(directory, "bin");
  for (const path of [home, repo, bin]) mkdirSync(path);
  const saved = { OPENRIG_HOME: process.env.OPENRIG_HOME, PATH: process.env.PATH };
  process.env.OPENRIG_HOME = home;
  // The fixture client is the first thing the resolver finds on PATH. It records what it was
  // given and then exits non-zero, which is what a client that cannot start its turn does.
  process.env.PATH = [bin, ...(saved.PATH ?? "").split(delimiter).filter(Boolean)].join(delimiter);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  let daemon: Awaited<ReturnType<typeof createDaemon>> | undefined;
  try {
    git("init", "--quiet", "--initial-branch=main");
    git("config", "user.name", "test"); git("config", "user.email", "test@example.invalid");
    writeFileSync(join(repo, "plan.md"), "approved plan\n");
    git("add", "plan.md"); git("commit", "--quiet", "-m", "base");
    // The fixture is a real executable with the client's own name, so PATH resolution finds it
    // exactly as it would find the installed client.
    writeFileSync(join(bin, executable), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const file = ${JSON.stringify(join(directory, "client.json"))};
fs.writeFileSync(file, JSON.stringify({ args: process.argv.slice(2), prompt: fs.readFileSync(0, 'utf8'), cwd: process.cwd(),
  path: process.env.PATH }));
process.stderr.write("Error: the fixture client cannot reach its provider\\n");
process.exit(1);
`, { mode: 0o755 });
    const policy = unisolatedPolicyCapability(unisolatedWorkerRoots(home).policyRevision);
    const binding: PlanBinding = {
      artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
      planRef: "plan.md", planDigest: hashBytes("approved plan\n"), repository: { root: repo, identity: "git:" + "a".repeat(40) },
      readPaths: ["plan.md"], writePaths: ["plan.md"], roles: ["lead", "implementer", "reviewer"],
      policyRevision: policy.policyRevision, policyFingerprint: policy.policyFingerprint,
      limits: { maxSessions: 1, maxActiveMs: 60_000, maxRetries: 0, maxReviewRounds: 0 },
    };
    daemon = await createDaemon({ dbPath: join(directory, "daemon.sqlite"), managedMode: true,
      teamControl: { credentials: { ownerToken: "owner-fixture" }, resolveBinding: () => binding },
      cmuxFactory: async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); } });
    const rig = daemon.deps.rigRepo.createRig("fixture", repo);
    const node = daemon.deps.rigRepo.addNode(rig.id, "dev.impl", { runtime, cwd: repo });
    const session = daemon.deps.sessionRegistry.registerSession(node.id, "dev-impl@fixture");
    const governance = daemon.deps.teamGovernance!;
    governance.createRun({ id: "run", rigId: rig.id, binding });
    let serial = 0;
    const command = (actionId: string, payload: unknown) => ({ protocolVersion: "1.0", runId: "run", actionId,
      expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: "default-" + ++serial, payload });
    governance.requestApproval(command("implementation", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "2030-01-01T00:00:00.000Z" }),
    { kind: "worker", sessionId: "lead@fixture" });
    expect(governance.decideApproval(command("implementation", { approvalVersion: 1, decision: "approved" }),
      { kind: "owner", sessionId: "owner-control" }, binding).status).toBe("accepted");
    expect(governance.createTask(command("task", {
      assignment: { taskId: "task", role: "implementer", paths: ["plan.md"], dependencies: [] },
      outputs: [], permissions: [], sourceSession: "lead@fixture", destinationSession: "dev-impl@fixture", body: "Read the plan.",
    }), binding).status).toBe("accepted");

    // U3 — a native turn records no pane, so the binding the launch reads is the seat itself.
    const result = await daemon.deps.startupOrchestrator!.startNode({
      rigId: rig.id, nodeId: node.id, sessionId: session.sessionId,
      binding: { id: `direct:${node.id}`, nodeId: node.id, cwd: repo, tmuxSession: "dev-impl@fixture",
        tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "" },
      adapter: daemon.deps.runtimeAdapters![runtime]!,
      plan: { runtime, cwd: repo, entries: [], diagnostics: [], conflicts: [], noOps: [] },
      resolvedStartupFiles: [], startupActions: [], isRestore: false, sessionName: "dev-impl@fixture", includeDurableObligations: false,
    });
    // The turn started and ended on its own: the launch is not a readiness failure.
    expect(result.ok, JSON.stringify(result.ok ? null : result.errors)).toBe(true);
    const observed = JSON.parse(readFileSync(join(directory, "client.json"), "utf8")) as
      { args: string[]; prompt: string; cwd: string; path: string };
    // The prompt reached the client on stdin, and the argv is the frozen contract.
    expect(observed.prompt).toContain("Read the plan.");
    expect(observed.cwd).toBe(daemon.deps.workflowRuntime!.assignedTreeFor("run", { taskId: "task" }));
    expect(observed.args).toContain(firstFlag);
    if (runtime === "claude-code") {
      expect(observed.args).toContain("-p");
      expect(observed.args).toContain("--include-partial-messages");
    } else {
      expect(observed.args.slice(0, 2)).toEqual(["exec", "--json"]);
      expect(observed.args.at(-1)).toBe("-");
    }
  } finally {
    await daemon?.deps.workflowRuntime?.closeManagedAttempts();
    daemon?.deps.attemptCompletion?.stop();
    if (daemon?.db.open) daemon.db.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (existsSync(directory)) { writable(directory); rmSync(directory, { recursive: true, force: true }); }
  }
}, 90_000);
});
