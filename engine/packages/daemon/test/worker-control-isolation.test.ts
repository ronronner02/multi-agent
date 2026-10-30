import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// T038 — installed-client acceptance.
//
// The U4 acceptance scenarios split into two halves that fail for different reasons, so they are
// proven differently and never substituted for one another.
//
//   * Provider-free. The real privileged launcher, the real bubblewrap boundary, the installed
//     policy and the T034 client lock are exercised end to end; the only thing absent is the
//     native client's model call. This half spends nothing.
//   * Provider calls. Those spend the inherited T010 allowance and live in
//     worker-live-acceptance.test.ts, which refuses to run unless the allowance has room.
//
// Facts are read from the installed policy, the launcher and the sandbox's own /proc. A launch
// flag proves only what was asked for, so it never closes an effective-behaviour claim.
//
// ACCEPTANCE MODE. Set MA_T038_ACCEPTANCE=1 where a receipt is required. A missing prerequisite is
// then a failure, not a skip: an acceptance gate that passes by running nothing is the defect this
// mode exists to prevent. Without it the suites skip, which is right for an ordinary unit run.

const POLICY = "/etc/multi-agent/worker-policy.json";
const LOCK = "/etc/multi-agent/client-lock.json";
const LAUNCHER = "/usr/local/libexec/multi-agent/worker-launch";
const NODE = "/opt/multi-agent/toolchain/node/bin/node";
const SUDO = "/usr/bin/sudo";
const ACCEPTANCE = process.env.MA_T038_ACCEPTANCE === "1";

interface InstalledPolicy {
  control_identity: string;
  worker_identities: string[];
  launch_callers: string[];
  paths: { assignment_root: string; worker_root: string; context_root: string; state_root: string; control_state_dir: string };
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

/** In acceptance mode a missing prerequisite fails the run rather than skipping it. */
function requireInstalled(): void {
  if (installed) return;
  if (ACCEPTANCE) {
    throw new Error("acceptance requires the installed policy, launcher and client lock; set them up or unset MA_T038_ACCEPTANCE");
  }
}

describe("acceptance prerequisites", () => {
  it(`${ACCEPTANCE ? "requires" : "reports"} the installed launcher, policy and lock`, () => {
    if (ACCEPTANCE) expect(installed, "installed launcher, policy and lock must exist").toBe(true);
    else expect(typeof installed).toBe("boolean");
  });
});

describe.skipIf(!installed && !ACCEPTANCE)("installed control surface", () => {
  beforeAll(requireInstalled);

  it("reads the installed policy, launcher and lock rather than any launch request", () => {
    expect(policy!.control_identity).toBe("ma-control");
    expect(policy!.worker_identities).toEqual(["ma-worker1", "ma-worker2", "ma-worker3"]);
    // A worker that could call the launcher would be its own boundary authority.
    for (const worker of policy!.worker_identities) expect(policy!.launch_callers).not.toContain(worker);
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
    // The launcher's caller check is the one that matters, so it is asserted directly rather than
    // inferred from sudo. A worker cannot obtain the grant at all, and no worker is listed as a
    // launch caller; both directions are checked so neither a sudo change nor a policy change can
    // open the path silently.
    for (const worker of policy!.worker_identities) {
      expect(policy!.launch_callers).not.toContain(worker);
      // A worker invoking the launcher directly must fail, and must not reach launcher policy at all.
      const direct = run(SUDO, ["-n", "-u", worker, "--", LAUNCHER, "--inspect", "--worker", worker,
        "--role", "implementer", "--tree", "/nonexistent", "--run", "run", "--attempt", "attempt", "--", "/bin/true"]);
      expect(direct.status, `${worker} must not reach the launcher`).not.toBe(0);
    }
    // The control identity does reach it, which is what makes the refusal above meaningful.
    const control = viaLauncher(["--inspect", "--worker", WORKER, "--role", "implementer", "--tree", "/nonexistent",
      "--run", "run", "--attempt", "attempt", "--client-lock", LOCK_DIGEST, "--", "/bin/true"]);
    expect(launcherError(control), "control reaches the launcher and receives a policy refusal").toBe("tree-missing");
  });
});

describe.skipIf(!installed && !ACCEPTANCE)("provider-free boundary proof against the installed launcher", () => {
  beforeAll(requireInstalled);

  // Scenario 3 and 13's containment half, measured from inside a real sandbox rather than read
  // from a flag. The launcher spawns the probe exactly as it spawns a native client, so the
  // boundary under test is the one the client runs in.
  //
  // The forbidden fixtures live in the control state directory, outside every source the launcher
  // mounts. A fixture placed inside the assigned tree sits at /work/<name> inside the sandbox, so a
  // probe of its original host pathname would pass by absence while the mounted alias stayed
  // reachable — a false positive this layout removes.
  let stage: string, tree: string, forbidden!: string, context!: string, runDir!: string;
  let sentinelToken: string, sentinelDatabase: string, sentinelWal: string, supervisor: string, controlSocket: string;
  let listener: ReturnType<typeof spawn> | undefined;
  let ownerServer: ReturnType<typeof createServer> | undefined;
  let ownerPort = 0;
  let gatewayHost: string | null = null;
  const tag = `t038-${randomBytes(4).toString("hex")}`;
  /** The names the fixtures carry, so the mounted tree can be checked for every one of them. */
  const FIXTURE_NAMES = ["owner.token", "state.db", "state.db-wal", "supervisor.sock", "control.sock"];

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
      read: {}, write: {}, list: {}, connect: {},
      allowedEdit: attempt(() => { fs.writeFileSync("/work/" + input.marker, "edit"); return fs.readFileSync("/work/" + input.marker, "utf8"); }),
      hostProcess: attempt(() => process.kill(input.hostPid, 0)),
      hostProcessMissing: attempt(() => process.kill(input.absentPid, 0)),
      windowsMount: attempt(() => fs.readdirSync("/usr/lib/wsl")),
      abstractSockets: fs.readFileSync("/proc/net/unix", "utf8").split("\n").filter((l) => / @/.test(l)).length,
      contextRead: attempt(() => fs.readFileSync("/context/instructions.txt", "utf8")),
      frameworkRead: attempt(() => fs.statSync("/framework").isDirectory()),
      ownContext: attempt(() => fs.readdirSync("/context").length),
      // The mount alias accounting: nothing forbidden may appear inside the one writable mount.
      workEntries: attempt(() => fs.readdirSync("/work")),
    };
    for (const p of input.denyRead) out.read[p] = attempt(() => fs.readFileSync(p).length);
    for (const p of input.denyWrite) out.write[p] = attempt(() => fs.closeSync(fs.openSync(p, "r+")));
    for (const p of input.denyList) out.list[p] = attempt(() => fs.readdirSync(p).length);
    for (const p of input.denySockets) out.connect[p] = await connect(p);
    // Loopback scan: what the sandbox can reach on its own namespace's 127.0.0.1.
    const scan = [];
    for (const port of input.loopbackScan) {
      const r = await new Promise((resolve) => {
        const s = net.connect({ host: "127.0.0.1", port });
        const done = (v) => { s.destroy(); resolve(v); };
        s.once("connect", () => done("open"));
        s.once("error", (e) => done(e.code));
        setTimeout(() => done("timeout"), 1500);
      });
      if (r === "open") scan.push(port);
    }
    out.loopbackOpen = scan;
    process.stdout.write(JSON.stringify(out));
  `;

  const launchProbe = (marker: string, extra: Record<string, unknown> = {}) => {
    const result = viaLauncher(["--worker", WORKER, "--role", "implementer", "--tree", tree,
      "--run", tag, "--attempt", tag, "--client-lock", LOCK_DIGEST, "--env", "TERM=xterm-256color", "--",
      NODE, "--input-type=module", "-e", PROBE, JSON.stringify({
        marker, hostPid: process.pid, absentPid: 4_000_000,
        denyRead: [sentinelToken, sentinelDatabase, sentinelWal, "/etc/shadow", "/etc/sudoers", `/home/${process.env.USER ?? "leo"}`],
        denyWrite: [sentinelToken, sentinelDatabase],
        denyList: [policy!.paths.worker_root + "/ma-worker2"],
        denySockets: [supervisor, controlSocket, ...FIXTURE_NAMES.map(name => "/work/" + name)],
        loopbackScan: [ownerPort, 3128],
        ...extra,
      })]);
    return { result, parsed: result.status === 0 ? JSON.parse(result.stdout) as Record<string, any> : undefined };
  };

  beforeAll(async () => {
    // Everything the worker must not reach is created control-owned inside the control state
    // directory, outside every source the launcher mounts, and confirmed live first, so a denial
    // below cannot be an artefact of a target that never existed. The projection reproduces the
    // launcher's own layout: context_root/<worker>/<run>/<attempt>, every level control-owned with
    // the worker's group and no write bit, which arrives through the private root's setgid bit.
    stage = `${policy!.paths.assignment_root}/ma-worker1/${tag}`;
    tree = stage;
    forbidden = `${policy!.paths.control_state_dir}/${tag}`;
    runDir = `${policy!.paths.context_root}/ma-worker1/${tag}`;
    context = `${runDir}/${tag}`;
    sentinelToken = `${forbidden}/owner.token`;
    sentinelDatabase = `${forbidden}/state.db`;
    sentinelWal = `${forbidden}/state.db-wal`;
    supervisor = `${forbidden}/supervisor.sock`;
    controlSocket = `${forbidden}/control.sock`;
    // The staging process holds the fixtures and the two control listeners for the whole suite, so
    // it is detached and polled: asControl would block until it exits, and a process group is what
    // the teardown can stop as a whole.
    const staged = spawn(SUDO, ["-n", "-u", policy!.control_identity, "--", NODE, "-e", `
      const fs = require("node:fs"), net = require("node:net");
      const workerGid = ${JSON.stringify(workerGid)};
      const secret = ${JSON.stringify(randomBytes(16).toString("hex"))};
      fs.mkdirSync(${JSON.stringify(tree)}, { recursive: true, mode: 0o770 });
      fs.mkdirSync(${JSON.stringify(forbidden)}, { recursive: true, mode: 0o700 });
      for (const file of [${JSON.stringify(sentinelToken)}, ${JSON.stringify(sentinelDatabase)}, ${JSON.stringify(sentinelWal)}]) {
        fs.writeFileSync(file, secret, { mode: 0o600 });
      }
      const contextParent = ${JSON.stringify(policy!.paths.context_root + "/ma-worker1")};
      fs.mkdirSync(${JSON.stringify(context)}, { recursive: true, mode: 0o2750 });
      fs.writeFileSync(${JSON.stringify(context + "/instructions.txt")}, "pinned context", { mode: 0o440 });
      fs.chmodSync(${JSON.stringify(context + "/instructions.txt")}, 0o440);
      fs.chmodSync(${JSON.stringify(context)}, 0o550);
      fs.chmodSync(${JSON.stringify(runDir)}, 0o550);
      for (const [owned, mode] of [[contextParent, 0o2750], [${JSON.stringify(runDir)}, 0o550], [${JSON.stringify(context)}, 0o550]]) {
        const st = fs.statSync(owned);
        if (st.uid !== process.getuid() || st.gid !== workerGid) {
          throw new Error("projection ownership mismatch at " + owned + ": " + st.uid + ":" + st.gid);
        }
      }
      // Two control-owned listeners the worker must never reach, kept alive for the whole suite.
      for (const socket of [${JSON.stringify(supervisor)}, ${JSON.stringify(controlSocket)}]) {
        net.createServer(s => { s.on("error", () => {}); s.end("control"); }).listen(socket, () => fs.chmodSync(socket, 0o600));
      }
      setTimeout(() => process.exit(0), 600000);
    `], { stdio: ["ignore", "pipe", "pipe"], detached: true });
    listener = staged;
    // Wait until both listeners are actually accepting, bounded. An early failure is reported here
    // rather than surfacing later as a denial against a target that never existed.
    const deadline = Date.now() + 20_000;
    let ready = false, stderr = "";
    staged.stderr?.on("data", chunk => { stderr += String(chunk); });
    while (Date.now() < deadline) {
      if (staged.exitCode !== null) break;
      const sockets = run("/usr/bin/ss", ["-Hlx"]).stdout;
      if (sockets.includes(supervisor) && sockets.includes(controlSocket)) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    expect(ready, `control listeners did not come up: ${stderr.slice(0, 300)}`).toBe(true);

    // The intended provider host, read as the control identity because the installed file is
    // 0640 control-group. Only the hostname is kept, so the bearer never reaches this process.
    const installed = asControl("/usr/bin/cat", ["/etc/multi-agent/provider-gateway.json"]);
    if (installed.status === 0) {
      gatewayHost = new URL((JSON.parse(installed.stdout) as { claude: { base_url: string } }).claude.base_url).hostname;
    }

    // A live owner-side loopback listener: the positive control for the loopback scan. It runs in
    // the host namespace, which the sandbox's own namespace is expected not to reach.
    ownerServer = createServer(socket => socket.end("owner"));
    const server = ownerServer;
    return new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => {
      ownerPort = (server.address() as { port: number }).port;
      resolve();
    }));
  }, 60_000);

  afterAll(async () => {
    if (!installed) return;
    ownerServer?.close();
    // The held listener is stopped with its whole process group and reaped here; leaving it to its
    // own 600-second timer would keep listeners and pipe handles alive past the suite.
    if (listener?.pid !== undefined && listener.exitCode === null) {
      try { process.kill(-listener.pid, "SIGKILL"); } catch { /* already gone */ }
      await new Promise<void>((resolve) => listener!.once("exit", () => resolve()));
    }
    expect(listener?.exitCode ?? 0).not.toBeNull();
    // Removal runs as the control identity and every status must succeed. The projection is 0550,
    // which also denies its owner unlink, so it is opened first; the assigned tree and the fixtures
    // are control-owned directories whose entries — including the worker's own edit — control can
    // unlink without changing their modes.
    const opened = asControl("/usr/bin/chmod", ["-R", "u+w", runDir]);
    expect(opened.status, `chmod ${runDir}: ${opened.stderr}`).toBe(0);
    for (const target of [runDir, stage, forbidden]) {
      const removed = asControl("/usr/bin/rm", ["-rf", target]);
      expect(removed.status, `rm -rf ${target}: ${removed.stderr}`).toBe(0);
    }
    // Absence is verified from the control identity, which can traverse the control state directory:
    // this runner cannot, so existsSync() here would report false for an inaccessible survivor too.
    // ENOENT and a refused lookup are told apart, so an access error can never read as removal.
    const absent = asControl(NODE, ["-e", `
      const fs = require("node:fs");
      console.log(${JSON.stringify([stage, runDir, forbidden])}.map(p => {
        try { fs.lstatSync(p); return "present"; } catch (e) { return e.code === "ENOENT" ? "absent" : "unreachable:" + e.code; }
      }).join(" "));
    `]);
    expect(absent.status, absent.stderr).toBe(0);
    expect(absent.stdout.trim(), "stage, projection and fixtures are gone").toBe("absent absent absent");
  });

  it("keeps its own live control targets reachable from the owner side before probing", async () => {
    // A denial is only meaningful against a target that is live. Both control listeners and the
    // owner loopback server are confirmed from outside the sandbox here; if any is dead, every
    // denial below would be vacuous.
    const sockets = asControl("/usr/bin/ss", ["-Hlx"]).stdout;
    expect(sockets, "supervisor socket is listening").toContain(supervisor);
    expect(sockets, "control socket is listening").toContain(controlSocket);
    const listening = run("/usr/bin/ss", ["-Hltn", `sport = :${ownerPort}`]);
    expect(listening.stdout, "owner loopback listener is live").toContain(`127.0.0.1:${ownerPort}`);
    // And the supervisor accepts a connection from the control identity, so a sandbox refusal
    // below is the boundary rather than a dead or unreadable socket. The test runner itself is
    // neither control nor worker and is correctly refused, which is why this runs as control.
    const client = asControl(NODE, ["-e", `
      const net = require("node:net");
      const sockets = ${JSON.stringify([supervisor, controlSocket])};
      const results = [];
      let pending = sockets.length;
      for (const socket of sockets) {
        const s = net.connect(socket);
        const done = (text) => { s.destroy(); results.push(text); if (--pending === 0) { console.log(results.join("\\n")); process.exit(0); } };
        s.once("connect", () => done("connected " + socket));
        s.once("error", (e) => done("failed " + socket + " " + e.code));
      }
    `], { timeout: 15_000 });
    expect(client.stdout, client.stderr).toContain("connected " + supervisor);
    expect(client.stdout).toContain("connected " + controlSocket);
    // The fixture files exist and are control-readable outside the sandbox, so the denials below
    // are measured against live targets rather than absent pathnames.
    for (const file of [sentinelToken, sentinelDatabase, sentinelWal]) {
      expect(asControl("/usr/bin/stat", ["-c", "%s", file]).status, `live fixture ${file}`).toBe(0);
    }
    // And none of them is inside the assigned tree, which is what the sandbox mounts at /work.
    const treeEntries = asControl("/usr/bin/ls", ["-A", tree]).stdout.split("\n").filter(Boolean);
    for (const name of FIXTURE_NAMES) expect(treeEntries, `${name} must not be inside the mounted tree`).not.toContain(name);
  }, 60_000);

  it("denies owner token, database, supervisor and host access while the allowed edit succeeds", async () => {
    const { result, parsed } = launchProbe(`${tag}-probe`);
    expect(result.status, result.stderr.slice(0, 400)).toBe(0);
    const probe = parsed!;
    // Identity and privilege are the boundary's, not the caller's.
    expect(probe.identity.uid).not.toBe(0);
    expect(probe.identity.noNewPrivileges).toBe("1");
    expect(probe.identity.capabilities).toBe("0000000000000000");
    // Every required denial holds: the owner token, the database and its WAL, host credential
    // stores, another worker's tree, and both live control sockets.
    for (const path of [sentinelToken, sentinelDatabase, sentinelWal, "/etc/shadow", "/etc/sudoers"]) {
      expect(probe.read[path]?.ok, `read ${path}`).toBe(false);
    }
    expect(probe.write[sentinelToken]?.ok, "write owner token").toBe(false);
    expect(probe.write[sentinelDatabase]?.ok, "write database").toBe(false);
    expect(probe.list[policy!.paths.worker_root + "/ma-worker2"]?.ok, "list another worker").toBe(false);
    for (const socket of [supervisor, controlSocket, ...FIXTURE_NAMES.map(name => "/work/" + name)]) {
      expect(probe.connect[socket]?.ok, `connect ${socket}`).toBe(false);
    }
    // The mount alias accounting: the fixtures are outside the mounted tree, so none of their
    // names exists at /work and the denials above are not passing on a mounted copy.
    expect(probe.workEntries.ok).toBe(true);
    for (const name of FIXTURE_NAMES) expect(probe.workEntries.value, `/work/${name}`).not.toContain(name);
    // A live host process is invisible: inside a PID namespace it is simply absent, so ESRCH is
    // the expected refusal. The live pid was confirmed from the owner side by the previous test,
    // which is what makes its absence here the boundary's doing rather than a dead target.
    expect(probe.hostProcess.ok, "host process signal").toBe(false);
    expect(probe.hostProcess.code).toBe("ESRCH");
    expect(probe.hostProcessMissing.code).toBe("ESRCH");
    // The allowed in-scope edit succeeds: a boundary that denies everything is broken, not strong.
    expect(probe.allowedEdit).toEqual({ ok: true, value: "edit" });
    // The projection is readable and the framework is present, so the denials above are selective.
    expect(probe.contextRead).toEqual({ ok: true, value: "pinned context" });
    expect(probe.frameworkRead.ok).toBe(true);
    expect(probe.abstractSockets).toBe(0);
  }, 180_000);

  it("repeats every earlier denial on a second launch of the same boundary", async () => {
    // Not a resume: this is a second fresh invocation through the same launcher. It is labelled as
    // such because a native-client resume is what the live half proves, and calling this a resume
    // would let a broken resume path leave this test green.
    const { result, parsed } = launchProbe(`${tag}-repeat`);
    expect(result.status, result.stderr.slice(0, 400)).toBe(0);
    const probe = parsed!;
    expect(probe.identity.capabilities).toBe("0000000000000000");
    expect(probe.identity.noNewPrivileges).toBe("1");
    expect(probe.identity.uid).not.toBe(0);
    for (const path of [sentinelToken, sentinelDatabase, sentinelWal, "/etc/shadow", "/etc/sudoers"]) {
      expect(probe.read[path]?.ok, `read ${path}`).toBe(false);
    }
    expect(probe.write[sentinelToken]?.ok).toBe(false);
    expect(probe.list[policy!.paths.worker_root + "/ma-worker2"]?.ok).toBe(false);
    for (const socket of [supervisor, controlSocket, ...FIXTURE_NAMES.map(name => "/work/" + name)]) {
      expect(probe.connect[socket]?.ok).toBe(false);
    }
    for (const name of FIXTURE_NAMES) expect(probe.workEntries.value, `/work/${name}`).not.toContain(name);
    expect(probe.hostProcess.ok).toBe(false);
    expect(probe.abstractSockets).toBe(0);
    expect(probe.allowedEdit).toEqual({ ok: true, value: "edit" });
  }, 180_000);

  it("reaches its allowed endpoints while every host surface and unlisted origin stays unreachable", async () => {
    // KTD23's reachable set, enumerated from inside the sandbox rather than inferred from the
    // namespace identity. The unlisted-origin check names the exact failure it expects, because
    // accepting "anything that is not 200" would let a redirect or an error page pass.
    const marker = `${tag}-net`;
    const result = viaLauncher(["--worker", WORKER, "--role", "implementer", "--tree", tree,
      "--run", tag, "--attempt", tag, "--client-lock", LOCK_DIGEST, "--env", "TERM=xterm-256color", "--",
      NODE, "--input-type=module", "-e", String.raw`
        import net from "node:net";
        import { spawnSync } from "node:child_process";
        const ownerPort = Number(process.argv[1]), gatewayHost = process.argv[2];
        const probe = (host, port) => new Promise((resolve) => {
          const s = net.connect({ host, port });
          const done = (r) => { s.destroy(); resolve(r); };
          s.once("connect", () => done("reachable"));
          s.once("error", (e) => done(e.code ?? "error"));
          setTimeout(() => done("timeout"), 4000);
        });
        // -w prints the CONNECT status for a proxied request, which is what the filter decides.
        const curl = (url) => {
          const r = spawnSync("/usr/bin/curl", ["-s", "-o", "/dev/null", "-m", "25", "-w", "%{http_code} %{http_connect}", url],
            { encoding: "utf8", timeout: 35000 });
          return (r.stdout || "").trim();
        };
        const out = {
          registry: curl("https://registry.npmjs.org/"),
          unlistedHost: curl("https://example.com/"),
          ipLiteral: curl("https://1.1.1.1/"),
          // The node script hears its own arguments from argv[1], not argv[2]. Off by one, the owner
          // probe tested port 0 and the gateway probe an undefined default host, so ordinary
          // refusals passed for targets that were never tried. The echo is what makes that visible.
          argvEcho: { ownerPort, gatewayHost },
          loopbackOwner: await probe("127.0.0.1", ownerPort),
          gatewayHost: gatewayHost ? await probe(gatewayHost, 443) : "not-configured",
          overlay: await probe("100.100.100.100", 53),
          proxy: process.env.HTTPS_PROXY ?? null,
        };
        process.stdout.write(JSON.stringify(out));
      `, String(ownerPort), String(gatewayHost ?? "")]);
    expect(result.status, result.stderr.slice(0, 400)).toBe(0);
    const reach = JSON.parse(result.stdout) as Record<string, any>;
    // The probe used the targets it was given: the live owner port and the installed gateway host.
    expect(reach.argvEcho.ownerPort, "the probe received the live owner port").toBe(ownerPort);
    expect(reach.argvEcho.gatewayHost, "the probe received the intended gateway host").toBe(gatewayHost ?? "");
    // The allowed registry endpoint succeeds through the filter; the sandbox uses its own relay.
    expect(reach.registry).toBe("200 200");
    expect(reach.proxy).toBe("http://127.0.0.1:3128");
    // An unlisted host and a raw IP are refused by the filter itself, which is a CONNECT 403 — not
    // merely a non-200 response, and never a redirect.
    expect(reach.unlistedHost).toBe("000 403");
    expect(reach.ipLiteral).toBe("000 403");
    // The live owner loopback listener and the overlay resolver are unreachable. The provider host
    // named by the installed gateway is added only when one is installed: inventing a target, or
    // probing an undefined one, would make the denial vacuous.
    for (const [name, value] of [["loopbackOwner", reach.loopbackOwner], ["overlay", reach.overlay]] as const) {
      expect(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "timeout", "EAI_AGAIN"],
        `${name}=${value}`).toContain(value);
    }
    if (gatewayHost === null) {
      expect(ACCEPTANCE, "acceptance requires the installed provider gateway to name the intended host").toBe(false);
    } else {
      expect(gatewayHost, "the intended provider host is a DNS name").toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i);
      expect(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "timeout", "EAI_AGAIN"],
        `gatewayHost=${reach.gatewayHost}`).toContain(reach.gatewayHost);
    }
  }, 180_000);
});