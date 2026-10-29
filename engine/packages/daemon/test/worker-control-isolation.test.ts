import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";

// T038 — installed-client acceptance.
//
// U4's scenarios split into two halves that fail for different reasons, so they are proven
// differently and never substituted for one another.
//
//   * Provider-free. The real privileged launcher, the real bubblewrap boundary, the installed
//     policy and the T034 client lock are exercised end to end; the only thing absent is the
//     native client's model call. This half runs on any provisioned host and spends nothing.
//   * Provider calls. Those are the only runs that spend the inherited T010 allowance, and they
//     are not in this file yet: a live launch refuses without a signed-in worker home
//     (`managed_provider_signin_required`), and no worker home on this host is signed in.
//     Adding them here would either fake the sign-in or spend nothing while appearing to pass.
//
// Facts are read from the installed policy, the launcher and the client's own reported state.
// A launch flag proves only what was asked for, so it never closes an effective-hook claim.

const POLICY = "/etc/multi-agent/worker-policy.json";
const LOCK = "/etc/multi-agent/client-lock.json";
const LAUNCHER = "/usr/local/libexec/multi-agent/worker-launch";
const NODE = "/opt/multi-agent/toolchain/node/bin/node";
const SUDO = "/usr/bin/sudo";

interface InstalledPolicy {
  control_identity: string;
  worker_identities: string[];
  launch_callers: string[];
  paths: { assignment_root: string; worker_root: string; context_root: string; mailbox_root: string; state_root: string };
  sandbox: Record<string, unknown>;
}

const installed = existsSync(POLICY) && existsSync(LOCK) && existsSync(LAUNCHER);
const policy: InstalledPolicy | undefined = installed
  ? JSON.parse(readFileSync(POLICY, "utf8")) as InstalledPolicy : undefined;

const run = (file: string, args: string[], opts: { timeout?: number; input?: string } = {}) => {
  const result = spawnSync(file, args, { encoding: "utf8", timeout: opts.timeout ?? 60_000, input: opts.input });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error?.code ?? null };
};

/** The only privileged call the daemon ever makes, reached exactly as production reaches it. */
const asControl = (file: string, args: string[], opts: { timeout?: number; input?: string } = {}) =>
  run(SUDO, ["-n", "-u", policy!.control_identity, "--", file, ...args], opts);
const viaLauncher = (args: string[], opts: { timeout?: number; input?: string } = {}) =>
  asControl(SUDO, ["-n", LAUNCHER, ...args], opts);

const WORKER = "ma-worker1";
const workerGid = installed ? Number(run("/usr/bin/id", ["-g", WORKER]).stdout.trim()) : -1;
/** Inspect mode binds the caller's digest to the installed lock's own hash, so use that value. */
const LOCK_DIGEST = installed
  ? "sha256:" + createHash("sha256").update(readFileSync(LOCK)).digest("hex") : "";

/** The launcher reports refusals as one JSON line on stderr; nothing else is read from it. */
const launcherError = (result: { stderr: string }) => {
  const line = result.stderr.split("\n").find(row => row.includes("worker_launch_error"));
  return line ? (JSON.parse(line) as { worker_launch_error: string }).worker_launch_error : null;
};

describe.skipIf(!installed)("installed control surface", () => {
  // Nothing here starts a worker or a client. It establishes that the facts the provider-free
  // probes and the allowance accounting both depend on are the installed ones, not defaults.
  it("reads the installed policy, launcher and lock rather than any launch request", () => {
    expect(policy!.control_identity).toBe("ma-control");
    expect(policy!.worker_identities).toEqual(["ma-worker1", "ma-worker2", "ma-worker3"]);
    // A worker that could call the launcher would be its own boundary authority.
    expect(policy!.launch_callers).not.toContain("ma-worker1");
    for (const identity of [policy!.control_identity, ...policy!.worker_identities]) {
      expect(run("/usr/bin/id", ["-u", identity]).status, `identity ${identity}`).toBe(0);
    }
    expect(readFileSync(LAUNCHER).length).toBeGreaterThan(0);
    const lock = JSON.parse(readFileSync(LOCK, "utf8")) as { clients: Record<string, { version: string; files: unknown[] }> };
    expect(Object.keys(lock.clients).sort()).toEqual(["claude-code", "codex"]);
    for (const entry of Object.values(lock.clients)) {
      expect(entry.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(entry.files.length).toBeGreaterThan(0);
    }
  });

  it("refuses a launch caller that is not the control identity", () => {
    // The launcher's caller check is the one that matters, so it is asserted directly rather
    // than inferred from sudo: a worker identity reaching the launcher is still refused, and no
    // worker identity is listed as a launch caller in the installed policy.
    for (const worker of policy!.worker_identities) {
      expect(policy!.launch_callers).not.toContain(worker);
    }
    const worker = run(SUDO, ["-n", "-u", WORKER, "--", SUDO, "-n", LAUNCHER, "--inspect",
      "--worker", WORKER, "--role", "implementer", "--tree", "/nonexistent", "--run", "run", "--attempt", "attempt",
      "--mailbox", "1:2", "--client-lock", LOCK_DIGEST, "--", "/bin/true"]);
    // Either the worker cannot reach the launcher at all (no sudo grant), or the launcher itself
    // refuses the caller. Both are refusals; a successful inspect would be the failure.
    expect(worker.status).not.toBe(0);
    expect([null, "caller-not-allowed"]).toContain(launcherError(worker));
  });
});

describe.skipIf(!installed)("provider-free boundary proof against the installed launcher", () => {
  // Scenario 3 and 13's containment half, measured from inside a real sandbox rather than read
  // from a flag. The launcher spawns the probe exactly as it spawns a native client, so the
  // boundary under test is the one the client runs in.
  let stage: string, tree: string, context!: string;
  let sentinelToken: string, supervisor: string;
  const tag = `t038-${randomBytes(4).toString("hex")}`;

  const PROBE = String.raw`
    import fs from "node:fs";
    import net from "node:net";
    const input = JSON.parse(process.argv[1]);
    const attempt = (fn) => { try { return { ok: true, value: fn() }; } catch (e) { return { ok: false, code: e.code ?? String(e.message).slice(0, 60) }; } };
    const connect = (p) => new Promise((resolve) => {
      const s = net.connect(p);
      const done = (r) => { s.destroy(); resolve(r); };
      s.once("connect", () => done({ ok: true }));
      s.once("error", (e) => done({ ok: false, code: e.code }));
      setTimeout(() => done({ ok: false, code: "TIMEOUT" }), 3000);
    });
    const status = fs.readFileSync("/proc/self/status", "utf8");
    const field = (k) => (status.match(new RegExp("^" + k + ":\\s*(.*)$", "m")) ?? [])[1];
    const out = {
      identity: { uid: process.getuid(), noNewPrivileges: field("NoNewPrivs"), capabilities: field("CapEff") },
      read: {}, write: {}, connect: {},
      allowedEdit: attempt(() => { fs.writeFileSync("/work/" + input.marker, "edit"); return fs.readFileSync("/work/" + input.marker, "utf8"); }),
      hostProcess: attempt(() => process.kill(input.hostPid, 0)),
      windowsMount: attempt(() => fs.readdirSync("/usr/lib/wsl")),
      abstractSockets: fs.readFileSync("/proc/net/unix", "utf8").split("\n").filter((l) => / @/.test(l)).length,
    };
    for (const p of input.denyRead) out.read[p] = attempt(() => fs.readFileSync(p).length);
    for (const p of input.denyWrite) out.write[p] = attempt(() => fs.closeSync(fs.openSync(p, "r+")));
    for (const p of input.denySockets) out.connect[p] = await connect(p);
    process.stdout.write(JSON.stringify(out));
  `;

  beforeAll(() => {
    // The launcher derives the projection as context_root/<worker>/<run>/<attempt> and then
    // verifies every ancestry component: not worker-owned, not group- or other-writable, and for
    // the private root itself control-owned with the worker's group and no other access. The
    // fixture reproduces that layout rather than approximating it, so a pass below is the
    // production check and not a relaxed variant of it.
    stage = `${policy!.paths.assignment_root}/ma-worker1/${tag}`;
    tree = stage;
    context = `${policy!.paths.context_root}/ma-worker1/${tag}/${tag}`;
    sentinelToken = `${stage}/owner.token`;
    supervisor = `${stage}/supervisor.sock`;
    const result = asControl(NODE, ["-e", `
      const fs = require("node:fs"), net = require("node:net");
      const workerGid = ${JSON.stringify(workerGid)};
      const controlUid = process.getuid();
      fs.mkdirSync(${JSON.stringify(tree)}, { recursive: true, mode: 0o770 });
      fs.writeFileSync(${JSON.stringify(sentinelToken)}, ${JSON.stringify(randomBytes(16).toString("hex"))}, { mode: 0o600 });
      // The private root is setgid and already control-owned with the worker's group, so every
      // directory created below it inherits that group. The control identity is not in the
      // worker's group and could not chown, which is why the installed layout relies on setgid
      // inheritance rather than transferring ownership. A missing setgid bit therefore fails
      // loudly here instead of producing a projection the launcher rejects.
      const contextParent = ${JSON.stringify(policy!.paths.context_root + "/ma-worker1")};
      const runDir = ${JSON.stringify(policy!.paths.context_root + "/ma-worker1/" + tag)};
      fs.mkdirSync(${JSON.stringify(context)}, { recursive: true, mode: 0o2750 });
      fs.writeFileSync(${JSON.stringify(context + "/instructions.txt")}, "pinned context", { mode: 0o440 });
      fs.chmodSync(${JSON.stringify(context + "/instructions.txt")}, 0o440);
      fs.chmodSync(${JSON.stringify(context)}, 0o550);
      fs.chmodSync(runDir, 0o550);
      // The ownership the launcher checks must hold on every component, so assert it here.
      const parent = fs.statSync(contextParent);
      if (!(parent.mode & 0o2000)) {
        throw new Error("context root is not setgid, so created directories cannot inherit the worker group: " + contextParent);
      }
      const expected = { uid: controlUid, gid: workerGid };
      for (const owned of [contextParent, runDir, ${JSON.stringify(context)}]) {
        const st = fs.statSync(owned);
        if (st.uid !== expected.uid || st.gid !== expected.gid) {
          throw new Error("projection ownership mismatch at " + owned + ": " + st.uid + ":" + st.gid);
        }
      }
      net.createServer((sock) => { sock.on("error", () => {}); sock.end("supervisor"); })
        .listen(${JSON.stringify(supervisor)}, () => { console.log("listening"); process.exit(0); });
    `]);
    expect(result.stdout).toContain("listening");
  });

  afterAll(() => {
    if (!installed) return;
    // The projection is tightened to 0550 so the launcher accepts it, which also means its own
    // owner cannot unlink inside it. Restore write permission first, then remove both trees;
    // leaving them behind would accumulate one projection per run under the control root.
    const runDir = `${policy!.paths.context_root}/ma-worker1/${tag}`;
    asControl("/usr/bin/chmod", ["-R", "u+w", runDir]);
    asControl("/usr/bin/rm", ["-rf", stage, runDir]);
    expect(existsSync(stage), "stage tree removed").toBe(false);
    expect(existsSync(runDir), "projection removed").toBe(false);
  });

  it("denies owner-token, database, supervisor and host access while the allowed edit succeeds", async () => {
    const marker = `${tag}-probe`;
    const result = viaLauncher(["--worker", "ma-worker1", "--role", "implementer", "--tree", tree,
      "--run", tag, "--attempt", tag, "--client-lock", LOCK_DIGEST, "--env", "TERM=xterm-256color", "--",
      NODE, "--input-type=module", "-e", PROBE, JSON.stringify({
        marker, hostPid: process.pid,
        denyRead: [sentinelToken, "/etc/shadow", "/etc/sudoers"],
        denyWrite: [sentinelToken],
        denySockets: [supervisor],
      })]);
    expect(result.status, result.stderr.slice(0, 300)).toBe(0);
    const probe = JSON.parse(result.stdout) as {
      identity: { uid: number; noNewPrivileges: string; capabilities: string };
      read: Record<string, { ok: boolean; code?: string }>;
      write: Record<string, { ok: boolean; code?: string }>;
      connect: Record<string, { ok: boolean; code?: string }>;
      allowedEdit: { ok: boolean; value?: string };
      hostProcess: { ok: boolean; code?: string };
      abstractSockets: number;
    };
    // Identity and privilege are the boundary's, not the caller's.
    expect(probe.identity.uid).not.toBe(0);
    expect(probe.identity.noNewPrivileges).toBe("1");
    expect(probe.identity.capabilities).toBe("0000000000000000");
    // Every required denial holds.
    for (const path of [sentinelToken, "/etc/shadow", "/etc/sudoers"]) {
      expect(probe.read[path]?.ok, `read ${path}`).toBe(false);
    }
    expect(probe.write[sentinelToken]?.ok, "write owner token").toBe(false);
    expect(probe.connect[supervisor]?.ok, "supervisor socket").toBe(false);
    expect(probe.hostProcess.ok, "host process signal").toBe(false);
    // And the allowed in-scope edit still succeeds: a boundary that denies everything is not
    // containment, it is a broken launch.
    expect(probe.allowedEdit).toEqual({ ok: true, value: "edit" });
    expect(probe.abstractSockets).toBe(0);
  }, 180_000);

  it("repeats the same denials after an exact resume of the same boundary", async () => {
    // Scenario 10's provider-free half: resume re-enters through the same launcher, so the
    // boundary must be identical rather than merely re-established.
    const marker = `${tag}-resume`;
    const result = viaLauncher(["--worker", "ma-worker1", "--role", "implementer", "--tree", tree,
      "--run", tag, "--attempt", tag, "--client-lock", LOCK_DIGEST, "--env", "TERM=xterm-256color", "--",
      NODE, "--input-type=module", "-e", PROBE, JSON.stringify({
        marker, hostPid: process.pid, denyRead: [sentinelToken, "/etc/shadow"], denyWrite: [sentinelToken], denySockets: [supervisor],
      })]);
    expect(result.status, result.stderr.slice(0, 300)).toBe(0);
    const probe = JSON.parse(result.stdout) as {
      read: Record<string, { ok: boolean }>; write: Record<string, { ok: boolean }>;
      connect: Record<string, { ok: boolean }>; allowedEdit: { ok: boolean; value?: string };
      identity: { uid: number; capabilities: string; noNewPrivileges: string };
    };
    expect(probe.identity.capabilities).toBe("0000000000000000");
    expect(probe.identity.noNewPrivileges).toBe("1");
    expect(probe.read[sentinelToken]?.ok).toBe(false);
    expect(probe.read["/etc/shadow"]?.ok).toBe(false);
    expect(probe.write[sentinelToken]?.ok).toBe(false);
    expect(probe.connect[supervisor]?.ok).toBe(false);
    expect(probe.allowedEdit).toEqual({ ok: true, value: "edit" });
  }, 180_000);

  it("reaches its provider and package endpoints while every host surface stays unreachable", async () => {
    // Scenario 18's reachable set, enumerated from inside the sandbox rather than inferred
    // from the namespace identity. KTD23 makes this a re-run gate, not a one-time result.
    const marker = `${tag}-net`;
    const result = viaLauncher(["--worker", "ma-worker1", "--role", "implementer", "--tree", tree,
      "--run", tag, "--attempt", tag, "--client-lock", LOCK_DIGEST, "--env", "TERM=xterm-256color", "--",
      NODE, "--input-type=module", "-e", String.raw`
        import net from "node:net";
        import { spawnSync } from "node:child_process";
        const probe = (host, port) => new Promise((resolve) => {
          const s = net.connect({ host, port });
          const done = (r) => { s.destroy(); resolve(r); };
          s.once("connect", () => done("reachable"));
          s.once("error", (e) => done(e.code ?? "error"));
          setTimeout(() => done("timeout"), 4000);
        });
        const registry = spawnSync("/usr/bin/curl", ["-s", "-m", "20", "-o", "/dev/null", "-w", "%{http_code}", "https://registry.npmjs.org/"], { encoding: "utf8", timeout: 30000 });
        const unlisted = spawnSync("/usr/bin/curl", ["-s", "-m", "15", "-o", "/dev/null", "-w", "%{http_code}", "https://example.com/"], { encoding: "utf8", timeout: 30000 });
        process.stdout.write(JSON.stringify({
          registry: registry.stdout.trim(),
          unlisted: unlisted.stdout.trim(),
          loopback: await probe("127.0.0.1", 22),
          gateway: await probe("192.168.0.1", 443),
          overlay: await probe("100.100.100.100", 53),
        }));
      `]);
    expect(result.status, result.stderr.slice(0, 300)).toBe(0);
    const reach = JSON.parse(result.stdout) as Record<string, string>;
    // The allowed registry endpoint succeeds through the filter; nothing else does.
    expect(reach.registry).toBe("200");
    expect(reach.unlisted).not.toBe("200");
    for (const surface of ["loopback", "gateway", "overlay"]) {
      expect(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "timeout", "EAI_AGAIN"], `${surface}=${reach[surface]}`)
        .toContain(reach[surface]);
    }
  }, 180_000);
});