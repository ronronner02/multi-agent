import { expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon } from "../src/startup.js";
import { hashBinding, hashBytes } from "../src/domain/plan-governance.js";
import { unisolatedPolicyCapability } from "../src/routes/team-start.js";
import { unisolatedWorkerRoots } from "../src/domain/unisolated-roots.js";
import type { PlanBinding } from "../src/contracts/team-control.js";

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
  ["codex", "codex", "-a"],
] as const)("submits the default %s executable to a real shell without a launch override", async (runtime, executable, firstFlag) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "default-native-command-")));
  const home = join(directory, "home"), repo = join(directory, "repo"), bin = join(directory, "bin");
  for (const path of [home, repo, bin, join(directory, "tmux")]) mkdirSync(path);
  const saved = { OPENRIG_HOME: process.env.OPENRIG_HOME, TMUX_TMPDIR: process.env.TMUX_TMPDIR };
  process.env.OPENRIG_HOME = home;
  process.env.TMUX_TMPDIR = join(directory, "tmux");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  const tmux = (...args: string[]) => execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let daemon: Awaited<ReturnType<typeof createDaemon>> | undefined;
  try {
    git("init", "--quiet", "--initial-branch=main");
    git("config", "user.name", "test"); git("config", "user.email", "test@example.invalid");
    writeFileSync(join(repo, "plan.md"), "approved plan\n");
    git("add", "plan.md"); git("commit", "--quiet", "-m", "base");
    const policy = unisolatedPolicyCapability(unisolatedWorkerRoots(home).policyRevision);
    const binding: PlanBinding = {
      artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
      planRef: "plan.md", planDigest: hashBytes("approved plan\n"), repository: { root: repo, identity: "git:" + "a".repeat(40) },
      readPaths: ["plan.md"], writePaths: ["plan.md"], roles: ["lead", "implementer", "reviewer"],
      policyRevision: policy.policyRevision, policyFingerprint: policy.policyFingerprint,
      limits: { maxSessions: 1, maxActiveMs: 2_000, maxRetries: 0, maxReviewRounds: 0 },
    };
    daemon = await createDaemon({ dbPath: join(directory, "daemon.sqlite"), managedMode: true,
      teamControl: { credentials: { ownerToken: "owner-fixture" }, resolveBinding: () => binding },
    });
    const rig = daemon.deps.rigRepo.createRig("fixture", repo);
    const node = daemon.deps.rigRepo.addNode(rig.id, "dev.impl", { runtime, cwd: repo });
    const session = daemon.deps.sessionRegistry.registerSession(node.id, "dev-impl@fixture");
    // This real bash has an empty executable search path. It can parse and execute the typed
    // command, but no installed client or provider account is reachable from this terminal.
    tmux("new-session", "-d", "-s", "dev-impl@fixture", "-c", repo,
      `/usr/bin/env HOME='${home}' PATH='${bin}' /bin/bash --noprofile --norc`);
    const pane = tmux("list-panes", "-t", "dev-impl@fixture", "-F", "#{pane_id}").trim();
    daemon.deps.sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@fixture", tmuxPane: pane });
    const governance = daemon.deps.teamGovernance!;
    governance.createRun({ id: "run", rigId: rig.id, binding });
    let serial = 0;
    const command = (actionId: string, payload: unknown) => ({ protocolVersion: "1.0", runId: "run", actionId,
      expectedEntityVersion: governance.getRun("run").entityVersion, idempotencyKey: "default-" + ++serial, payload });
    governance.requestApproval(command("implementation", { kind: "orchestrator", action: "implementation",
      payload: { bindingDigest: hashBinding(binding) }, targetDigest: hashBinding(binding), expiresAt: "2030-01-01T00:00:00.000Z" }),
    { kind: "worker", sessionId: "lead@fixture" });
    const approval = governance.decideApproval(command("implementation", { approvalVersion: 1, decision: "approved" }),
      { kind: "owner", sessionId: "owner-control" }, binding);
    expect(approval.status, JSON.stringify(approval)).toBe("accepted");
    const created = governance.createTask(command("task", {
      assignment: { taskId: "task", role: "implementer", paths: ["plan.md"], dependencies: [] },
      outputs: [], permissions: [], sourceSession: "lead@fixture", destinationSession: "dev-impl@fixture", body: "Read the plan.",
    }), binding);
    expect(created.status, JSON.stringify(created)).toBe("accepted");

    const result = await daemon.deps.startupOrchestrator!.startNode({
      rigId: rig.id, nodeId: node.id, sessionId: session.id,
      binding: { ...daemon.deps.sessionRegistry.getBindingForNode(node.id)!, cwd: repo },
      adapter: daemon.deps.runtimeAdapters![runtime]!,
      plan: { runtime, cwd: repo, entries: [], diagnostics: [], conflicts: [], noOps: [] },
      resolvedStartupFiles: [], startupActions: [], isRestore: false, sessionName: "dev-impl@fixture", includeDurableObligations: false,
    });
    // A headless turn reports the client it could not start and ends by itself, so the pane is
    // read once it has ended rather than while it is still starting. An interactive client is
    // still running at this point, exactly as before.
    if (runtime === "claude-code") {
      await vi.waitFor(() => expect(tmux("display-message", "-p", "-t", pane, "#{pane_dead}").trim()).toBe("1"), { timeout: 30_000 });
    }
    const output = tmux("capture-pane", "-p", "-J", "-S", "-100", "-t", pane);
    // Claude Code is one headless turn now: the pane execs the readable view, which starts the
    // client with its own flags and the prompt on stdin. The client is still named on the pane's
    // command line, and this shell still cannot find it.
    if (runtime === "claude-code") {
      expect(output).toContain("agent-turn-view.mjs");
      expect(output).toContain(`'-p' '--permission-mode' 'bypassPermissions'`);
      // The turn's view reports a client that is not installed the way a shell does, which is
      // also the line the classifier names as a missing executable.
      expect(output).toContain(`${executable}: command not found`);
    } else {
      expect(output).toContain(`exec '${executable}' '${firstFlag}'`);
      expect(output).toContain(`${executable}: not found`);
    }
    expect(output).not.toContain("exec: --: invalid option");
    // Missing installation is not successful readiness for an interactive client, which never
    // becomes the pane's process. A headless turn is different in one way that matters here: the
    // pane execs the turn's view, the view starts, and the client it could not find is reported
    // and classified — so the turn ran and failed rather than failing to launch.
    expect(result.ok).toBe(runtime === "claude-code");
  } finally {
    try { tmux("kill-server"); } catch { /* The isolated server may already be gone. */ }
    await daemon?.deps.workflowRuntime?.closeManagedAttempts();
    daemon?.db.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    writable(directory); rmSync(directory, { recursive: true });
  }
}, 30_000);
