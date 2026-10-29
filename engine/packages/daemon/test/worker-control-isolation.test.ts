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
  paths: { assignment_root: string; worker_root: string; context_root: string; state_root: string };
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
  let stage: string, tree: string, context!: string, runDir!: string;
  let sentinelToken: string, sentinelDatabase: string, sentinelWal: string, supervisor: string, controlSocket: string;
  let listener: ReturnType<typeof spawn> | undefined;
  let ownerServer: ReturnType<typeof createServer> | undefined;
  let ownerPort = 0;
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
      read: {}, write: {}, list: {}, connect: {},
      allowedEdit: attempt(() => { fs.writeFileSync("/work/" + input.marker, "edit"); return fs.readFileSync("/work/" + input.marker, "utf8"); }),
      hostProcess: attempt(() => process.kill(input.hostPid, 0)),
      hostProcessMissing: attempt(() => process.kill(input.absentPid, 0)),
      windowsMount: attempt(() => fs.readdirSync("/usr/lib/wsl")),
      abstractSockets: fs.readFileSync("/proc/net/unix", "utf8").split("\n").filter((l) => / @/.test(l)).length,
      contextRead: attempt(() => fs.readFileSync("/context/instructions.txt", "utf8")),
      frameworkRead: attempt(() => fs.statSync("/framework").isDirectory()),
      ownContext: attempt(() => fs.readdirSync("/context").length),
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
        denySockets: [supervisor, controlSocket],
        loopbackScan: [ownerPort, 3128],
        ...extra,
      })]);
    return { result, parsed: result.status === 0 ? JSON.parse(result.stdout) as Record<string, any> : undefined };
  };

  beforeAll(async () => {
    // Everything the worker must not reach is created control-owned and confirmed live first, so a
    // denial below cannot be an artefact of a target that never existed. The projection reproduces
    // the launcher's own layout: context_root/<worker>/<run>/<attempt>, every level control-owned
    // with the worker's group and no write bit, which arrives through the private root's setgid bit.
    stage = `${policy!.paths.assignment_root}/ma-worker1/${tag}`;
    tree = stage;
    runDir = `${policy!.paths.context_root}/ma-worker1/${tag}`;
    context = `${runDir}/${tag}`;
    sentinelToken = `${stage}/owner.token`;
    sentinelDatabase = `${stage}/state.db`;
    sentinelWal = `${stage}/state.db-wal`;
    supervisor = `${stage}/supervisor.sock`;
    controlSocket = `${stage}/control.sock`;
    // The staging process holds the two control listeners for the whole suite, so it is spawned
    // in the background and polled: asControl would block until it exits.
    const staged = spawn(SUDO, ["-n", "-u", policy!.control_identity, "--", NODE, "-e", `
      const fs = require("node:fs"), net = require("node:net");
      const workerGid = ${JSON.stringify(workerGid)};
      const secret = ${JSON.stringify(randomBytes(16).toString("hex"))};
      fs.mkdirSync(${JSON.stringify(tree)}, { recursive: true, mode: 0o770 });
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
        net.createServer(s => { s.on("error", () => {}); s.end("control"); }).listen(socket, () => fs.chmodSync(socket, 0o666));
      }
      setTimeout(() => process.exit(0), 600000);
    `], { stdio: ["ignore", "pipe", "pipe"] });
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

    // A live owner-side loopback listener: the positive control for the loopback scan. It runs in
    // the host namespace, which the sandbox's own namespace is expected not to reach.
    ownerServer = createServer((_, res) => res.end("owner"));
    const server = ownerServer;
    return new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => {
      ownerPort = (server.address() as { port: number }).port;
      resolve();
    }));
  }, 60_000);

  afterAll(() => {
    if (!installed) return;
    ownerServer?.close();
    // The projection is 0550 so the launcher accepts it, which also denies its owner unlink.
    asControl("/usr/bin/chmod", ["-R", "u+w", runDir]);
    asControl("/usr/bin/rm", ["-rf", stage, runDir]);
    expect(existsSync(stage), "stage tree removed").toBe(false);
    expect(existsSync(runDir), "projection removed").toBe(false);
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
    for (const socket of [supervisor, controlSocket]) {
      expect(probe.connect[socket]?.ok, `connect ${socket}`).toBe(false);
    }
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
    for (const socket of [supervisor, controlSocket]) expect(probe.connect[socket]?.ok).toBe(false);
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
          loopbackOwner: await probe("127.0.0.1", Number(process.argv[2])),
          gatewayHost: await probe(process.argv[3], 443),
          overlay: await probe("100.100.100.100", 53),
          proxy: process.env.HTTPS_PROXY ?? null,
        };
        process.stdout.write(JSON.stringify(out));
      `, String(ownerPort), String(process.env.T038_GATEWAY_HOST ?? "")]);
    expect(result.status, result.stderr.slice(0, 400)).toBe(0);
    const reach = JSON.parse(result.stdout) as Record<string, string>;
    // The allowed registry endpoint succeeds through the filter; the sandbox uses its own relay.
    expect(reach.registry).toBe("200 200");
    expect(reach.proxy).toBe("http://127.0.0.1:3128");
    // An unlisted host and a raw IP are refused by the filter itself, which is a CONNECT 403 — not
    // merely a non-200 response, and never a redirect.
    expect(reach.unlistedHost).toBe("000 403");
    expect(reach.ipLiteral).toBe("000 403");
    // The live owner loopback listener, the LAN gateway and the overlay resolver are unreachable.
    for (const [name, value] of [["loopbackOwner", reach.loopbackOwner], ["gatewayHost", reach.gatewayHost], ["overlay", reach.overlay]] as const) {
      expect(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "timeout", "EAI_AGAIN"],
        `${name}=${value}`).toContain(value);
    }
  }, 180_000);
});