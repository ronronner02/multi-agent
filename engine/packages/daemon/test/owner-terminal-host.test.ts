import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OwnerTerminalHost,
  OwnerTerminalHostClient,
  type OwnerTerminalTransport,
  type OwnerTerminalHostOptions,
} from "../src/terminal/owner-terminal-host.js";

const liveRoots: string[] = [];

afterEach(async () => {
  for (const root of liveRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

function transportPair() {
  let output: ((data: string) => void) | null = null;
  const writes: string[] = [];
  const transport: OwnerTerminalTransport = {
    async start(onOutput) { output = onOutput; },
    async write(data) { writes.push(data); output?.(`echo:${data}`); },
    async close() { /* the host owns socket close notification */ },
  };
  return { transport, writes, emit: (data: string) => output?.(data) };
}

async function makeHost() {
  const root = await mkdtemp(join(tmpdir(), "openrig-owner-terminal-"));
  liveRoots.push(root);
  const socketPath = join(root, "owner.sock");
  const pair = transportPair();
  const host = new OwnerTerminalHost({ socketPath, token: "owner-host-token", ownerUid: process.getuid!(), transportFactory: () => pair.transport });
  await host.start();
  return { root, socketPath, pair, host, client: new OwnerTerminalHostClient({ socketPath, token: "owner-host-token" }) };
}

describe("OwnerTerminalHost", () => {
  it("relays bytes over a private socket without spawning a shell", async () => {
    const fixture = await makeHost();
    const received: string[] = [];
    const closed: Array<{ code: number; reason: string }> = [];
    const attachment = await fixture.client.attach({
      send: data => received.push(data),
      close: (code, reason) => closed.push({ code, reason }),
    });

    expect(received).toEqual([]);
    await attachment.sendInput("owner-input");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fixture.pair.writes).toEqual(["owner-input"]);
    expect(received).toContain("echo:owner-input");
    fixture.pair.emit("owner-output");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(received).toContain("owner-output");
    expect(closed).toEqual([]);

    await attachment.close();
    await fixture.host.stop();
    expect(await fixture.client.isAvailable()).toBe(false);
  });

  it("uses a 0600 socket and refuses a worker or forged token", async () => {
    const fixture = await makeHost();
    const mode = (await stat(fixture.socketPath)).mode & 0o777;
    expect(mode).toBe(0o600);

    const forged = new OwnerTerminalHostClient({ socketPath: fixture.socketPath, token: "wrong-token" });
    await expect(forged.attach({ send: () => {}, close: () => {} })).rejects.toThrow();
    await fixture.host.stop();
  });

  it("reports unavailable when the owner host is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "openrig-owner-terminal-"));
    liveRoots.push(root);
    const socketPath = join(root, "absent.sock");
    const client = new OwnerTerminalHostClient({ socketPath, token: "owner-host-token", connectTimeoutMs: 50 });
    expect(await client.isAvailable()).toBe(false);
    await expect(client.attach({ send: () => {}, close: () => {} })).rejects.toThrow("owner_terminal_unavailable");
  });

  it("keeps terminal bytes out of the host's on-disk socket directory", async () => {
    const fixture = await makeHost();
    const attachment = await fixture.client.attach({ send: () => {}, close: () => {} });
    await attachment.sendInput("sensitive-terminal-byte");
    await attachment.close();
    const entries = await readFile(fixture.socketPath).catch(() => null);
    expect(entries).toBeNull();
    await fixture.host.stop();
  });
  it("requires an explicit owner identity before creating a socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "openrig-owner-terminal-"));
    liveRoots.push(root);
    const options = { socketPath: join(root, "owner.sock"), transportFactory: () => transportPair().transport };
    const host = new OwnerTerminalHost(options as OwnerTerminalHostOptions);
    try {
      await expect(host.start()).rejects.toThrow("owner_terminal_owner_identity_mismatch");
      await expect(stat(options.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await host.stop(); }
  });

});
