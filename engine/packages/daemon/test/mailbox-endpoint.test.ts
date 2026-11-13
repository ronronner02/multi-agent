import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { ChatRepository } from "../src/domain/chat-repository.js";
import { MailboxDelivery } from "../src/domain/mailbox-delivery.js";
import { WorkerMailboxBridge } from "../src/adapters/worker-mailbox-bridge.js";
import {
  MAILBOX_PIPE_PREFIX, MAILBOX_SOCKET_NAME, admitsPosixMailboxEndpoint, mailboxEndpoint, socketIdentity,
} from "../src/domain/mailbox-endpoint.js";
import type { TeamControlCredentials } from "../src/middleware/auth-bearer-token.js";

/**
 * WINPIPE — the endpoint helper every mailbox transport fact goes through.
 *
 * Both platform branches run on any host because the helper takes the platform as an argument,
 * so Linux CI proves the Windows naming rule and the POSIX binding contract together. The parts
 * that need the real OS (a real pipe, a real socket file) stay in the Windows integration test.
 */
const worker = { token: "endpoint-worker-fixture", sessionId: "worker-session", runId: "run" };
const credentials: TeamControlCredentials = { ownerToken: "endpoint-owner-fixture", workers: [worker] };

describe("mailbox endpoint naming", () => {
  const directory = "C:\\state\\sock\\local\\attempt-1";
  const generation = "11111111-2222-3333-4444-555555555555";

  it("keeps the socket file on POSIX", () => {
    expect(mailboxEndpoint("/var/lib/multi-agent/sock/local/attempt-1", generation, "posix")).toEqual({
      transport: "unix", path: "/var/lib/multi-agent/sock/local/attempt-1/" + MAILBOX_SOCKET_NAME,
      bootstrapPath: "/var/lib/multi-agent/sock/local/attempt-1/bootstrap.json",
    });
  });

  it("names a pipe from the directory and the generation on Windows", () => {
    const endpoint = mailboxEndpoint(directory, generation, "win32");
    expect(endpoint.transport).toBe("pipe");
    expect(endpoint.path.startsWith(MAILBOX_PIPE_PREFIX)).toBe(true);
    // The name is a digest: the readable directory and generation never travel into the pipe
    // namespace, where any local process may enumerate them.
    expect(endpoint.path).not.toContain("attempt-1");
    expect(endpoint.path.slice(MAILBOX_PIPE_PREFIX.length)).toMatch(/^[a-f0-9]{32}$/);
    expect(endpoint.bootstrapPath).toBe(win32.join(directory, "bootstrap.json"));
  });

  it("derives one name per (directory, generation) and a different name for either alone", () => {
    const path = (dir: string, gen = generation) => mailboxEndpoint(dir, gen, "win32").path;
    expect(path("C:\\State\\Sock\\Local\\attempt-1")).toBe(path(directory));
    expect(path("C:/state/sock/local/attempt-1")).toBe(path(directory));
    expect(path(directory + "\\other")).not.toBe(path(directory));
    expect(path(directory, generation + "-other")).not.toBe(path(directory));
    // A traversal spelling resolves to the same directory it names, so it names the same pipe.
    expect(path("C:\\state\\sock\\local\\attempt-1\\..\\attempt-1")).toBe(path(directory));
  });

  it("carries a socket identity only for a Unix endpoint", () => {
    const unix = { transport: "unix", path: "/sock/mailbox.sock", dev: 9, ino: 22, uid: 990, gid: 990, generation } as const;
    const pipe = { transport: "pipe", path: MAILBOX_PIPE_PREFIX + "a", generation } as const;
    expect(socketIdentity(unix)).toEqual({ dev: 9, ino: 22, uid: 990, gid: 990 });
    expect(socketIdentity(pipe)).toBeNull();
    expect(socketIdentity(null)).toBeNull();
  });

  it("admits only the registered POSIX socket for the launcher's mailbox fact", () => {
    const mailboxRoot = "/var/lib/multi-agent/control/mailboxes";
    const socket = { transport: "unix", path: mailboxRoot + "/ma-worker1/run-1/attempt-1/mailbox.sock",
      dev: 9, ino: 22, uid: 990, gid: 990, generation } as const;
    const fact = { mailboxRoot, worker: "ma-worker1", runId: "run-1", attemptId: "attempt-1", controlUid: 990, controlGid: 990 };
    expect(admitsPosixMailboxEndpoint(socket, fact)).toBe(true);
    // A pipe is never mountable by the launcher, however well-formed its name.
    expect(admitsPosixMailboxEndpoint(mailboxEndpoint("/tmp/x", generation, "win32") as never, fact)).toBe(false);
    for (const change of [{ dev: -1 }, { ino: 0 }, { uid: 991 }, { gid: 991 }, { path: socket.path + "-other" },
      { path: "/var/lib/multi-agent/mailbox.sock" }, { generation: "-leading-dash" }]) {
      expect(admitsPosixMailboxEndpoint({ ...socket, ...change }, fact)).toBe(false);
    }
    for (const change of [{ mailboxRoot: undefined }, { worker: "ma-worker2" }, { runId: "run-2" },
      { attemptId: "attempt-2" }, { controlUid: 991 }, { controlGid: undefined }]) {
      expect(admitsPosixMailboxEndpoint(socket, { ...fact, ...change } as never)).toBe(false);
    }
  });
});

describe("mailbox bridge per platform", () => {
  let directory: string, db: ReturnType<typeof createDb>, chat: ChatRepository, bridges: WorkerMailboxBridge[];
  beforeEach(() => {
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), "winpipe-unit-")));
    db = createDb(); initializeDatabase(db);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'endpoint fixture')").run();
    chat = new ChatRepository(db);
    bridges = [];
  });
  afterEach(async () => {
    for (const bridge of bridges) await bridge.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const bridgeFor = (transport: "posix" | "win32") => {
    const bridge = new WorkerMailboxBridge({ directory, workerId: "worker", sessionId: worker.sessionId,
      runId: "run", attemptId: "attempt", rigId: "rig", taskId: "task", recipients: ["peer"],
      capability: `mailbox:${"a".repeat(43)}` },
    new MailboxDelivery(chat, () => "clear", () => null), chat, () => credentials, () => true, [], transport);
    bridges.push(bridge);
    return bridge;
  };
  const bootstrap = () => JSON.parse(readFileSync(join(directory, "bootstrap.json"), "utf8")) as Record<string, string>;

  // The POSIX branch cannot listen on a Windows host at all (that is the defect being fixed), and
  // a pipe name is not a Linux path, so the listening half is pinned to the host that can run it.
  // The Windows side is `worker-mailbox-pipe-windows.test.ts`.
  it.skipIf(process.platform === "win32")("publishes the socket path and unlinks it on close", async () => {
    const bridge = bridgeFor("posix");
    await bridge.listen();
    expect(bridge.endpoint()).toMatchObject({ transport: "unix", path: join(directory, MAILBOX_SOCKET_NAME) });
    // POSIX keeps the launcher's seven-field bootstrap: no extra key, because
    // `worker-launch.mjs` refuses any bootstrap whose key count differs.
    expect(Object.keys(bootstrap()).sort())
      .toEqual(["attemptId", "authorization", "capability", "generation", "runId", "sessionId", "taskId"]);
    await bridge.close();
    expect(existsSync(join(directory, MAILBOX_SOCKET_NAME))).toBe(false);
    expect(existsSync(join(directory, "bootstrap.json"))).toBe(false);
  });

  it.skipIf(process.platform !== "win32")("publishes a pipe name and a bootstrap the worker can connect with", async () => {
    const bridge = bridgeFor("win32");
    await bridge.listen();
    expect(bridge.endpoint()).toMatchObject({ transport: "pipe", path: mailboxEndpoint(directory, bridge.generation, "win32").path });
    // The Windows bootstrap adds exactly one field, `endpoint`, and nothing else differs.
    expect(Object.keys(bootstrap()).sort()).toEqual(["attemptId", "authorization", "capability", "endpoint",
      "generation", "runId", "sessionId", "taskId"]);
    expect(bootstrap().endpoint).toBe(bridge.endpoint().path);
    await bridge.close();
    // No socket file is ever created on this transport, and the bootstrap is removed.
    expect(existsSync(join(directory, MAILBOX_SOCKET_NAME))).toBe(false);
    expect(existsSync(join(directory, "bootstrap.json"))).toBe(false);
  });
});