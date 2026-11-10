import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const serveMock = vi.fn();
const createDaemonMock = vi.fn();
const serverMock = {
  prependListener: vi.fn(),
  close: vi.fn((done: (error?: Error) => void) => done()),
  closeIdleConnections: vi.fn(),
};
let signalListenersBefore: { SIGINT: Function[]; SIGTERM: Function[] };
let activeFixture: ReturnType<typeof makeDaemonFixture> | undefined;

function makeDaemonFixture(managed: boolean) {
  const db = {
    prepare: vi.fn(() => ({ get: vi.fn(() => managed ? {} : undefined) })),
  };
  const contextMonitor = { start: vi.fn(), stop: vi.fn() };
  const watchdogScheduler = { start: vi.fn(), stop: vi.fn() };
  const seatActivityService = { start: vi.fn(), stop: vi.fn(), getSeatState: vi.fn() };
  const seatStructuralActivityService = { start: vi.fn(), stop: vi.fn() };
  const seatIdentityReconciler = { start: vi.fn(), stop: vi.fn() };
  const healthDiagnosis = { start: vi.fn(), stop: vi.fn() };
  const startupServices = {
    contextMonitor: contextMonitor.start,
    watchdogScheduler: watchdogScheduler.start,
    seatActivity: seatActivityService.start,
    seatStructuralActivity: seatStructuralActivityService.start,
    seatIdentity: seatIdentityReconciler.start,
    healthDiagnosis: healthDiagnosis.start,
  };
  const deps = {
    rigRepo: { db },
    watchdogScheduler,
    seatActivityService,
    seatStructuralActivityService,
    seatIdentityReconciler,
    healthDiagnosis,
    settingsStore: {
      resolveOne: (key: string) => ({ value: key === "retention.enabled" ? false : undefined }),
    },
    daemonLifecycleStore: { recordHeartbeat: vi.fn(), recordStop: vi.fn() },
  };
  return {
    app: { fetch: vi.fn() },
    contextMonitor,
    deps,
    eventLoopMonitor: { stop: vi.fn() },
    injectWebSocket: vi.fn(),
    startupServices,
  };
}

vi.mock("@hono/node-server", () => ({
  serve: serveMock,
}));

vi.mock("../src/startup.js", () => ({
  createDaemon: createDaemonMock,
}));

describe("daemon startServer", () => {
  beforeEach(() => {
    signalListenersBefore = {
      SIGINT: process.listeners("SIGINT"),
      SIGTERM: process.listeners("SIGTERM"),
    };
    serveMock.mockReset();
    serverMock.prependListener.mockReset();
    serverMock.close.mockReset();
    serverMock.closeIdleConnections.mockReset();
    serveMock.mockReturnValue(serverMock);
    createDaemonMock.mockReset();
    createDaemonMock.mockImplementation(async ({ managedMode }: { managedMode?: boolean } = {}) => {
      activeFixture = makeDaemonFixture(Boolean(managedMode));
      return activeFixture;
    });
    delete process.env.MULTI_AGENT_MODE;
    delete process.env.OPENRIG_HOST;
    delete process.env.RIGGED_HOST;
    delete process.env.OPENRIG_BIND_HOST;
    delete process.env.OPENRIG_AUTH_BEARER_TOKEN;
    delete process.env.OPENRIG_TERMINAL_BEARER_TOKEN;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    // startServer installs shutdown handlers; keep this mock-only fixture isolated.
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      for (const listener of process.listeners(signal)) {
        if (!signalListenersBefore[signal].includes(listener)) {
          process.removeListener(signal, listener as () => void);
        }
      }
    }
    delete process.env.MULTI_AGENT_MODE;
    delete process.env.OPENRIG_HOST;
    delete process.env.RIGGED_HOST;
    delete process.env.OPENRIG_BIND_HOST;
    delete process.env.OPENRIG_AUTH_BEARER_TOKEN;
    delete process.env.OPENRIG_TERMINAL_BEARER_TOKEN;
    delete process.env.MULTI_AGENT_OWNER_TOKEN;
    activeFixture = undefined;
  });

  it("binds the daemon to loopback", async () => {
    const { startServer } = await import("../src/index.js");

    const server = await startServer(7441);

    expect(serveMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 7441, hostname: "127.0.0.1" }),
      expect.any(Function)
    );
    expect(server).toBe(serverMock);
    expect(serverMock.prependListener).toHaveBeenCalledWith(
      "request", expect.any(Function),
    );
  });

  it("does not require a terminal bearer token for the default loopback bind", async () => {
    const { startServer } = await import("../src/index.js");

    await startServer(7441);

    expect(createDaemonMock).toHaveBeenCalledWith(
      expect.objectContaining({ terminalBearerToken: null }),
    );
  });

  it("uses the daemon bearer token for terminal routes on explicit public binds", async () => {
    process.env.OPENRIG_BIND_HOST = "0.0.0.0";
    process.env.OPENRIG_AUTH_BEARER_TOKEN = "daemon-token";
    const { startServer } = await import("../src/index.js");

    await startServer(7441);

    expect(createDaemonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bearerToken: "daemon-token",
        terminalBearerToken: "daemon-token",
      }),
    );
  });

  it("starts every composed legacy service only in legacy mode", async () => {
    vi.useFakeTimers();
    process.env.MULTI_AGENT_MODE = "legacy";
    const { startServer } = await import("../src/index.js");

    await startServer(7441);
    const onListening = serveMock.mock.calls[0]?.[1] as ((info: { port: number }) => void) | undefined;
    expect(onListening).toBeTypeOf("function");
    onListening!({ port: 7441 });

    expect(createDaemonMock).toHaveBeenCalledWith(expect.objectContaining({ managedMode: false }));
    for (const [name, start] of Object.entries(activeFixture!.startupServices)) {
      expect(start, name).toHaveBeenCalled();
    }
  });

  it("starts none of the composed legacy services in managed mode", async () => {
    vi.useFakeTimers();
    process.env.MULTI_AGENT_MODE = "managed";
    const { startServer } = await import("../src/index.js");

    await startServer(7441);
    const onListening = serveMock.mock.calls[0]?.[1] as ((info: { port: number }) => void) | undefined;
    expect(onListening).toBeTypeOf("function");
    onListening!({ port: 7441 });

    expect(createDaemonMock).toHaveBeenCalledWith(expect.objectContaining({ managedMode: true }));
    for (const [name, start] of Object.entries(activeFixture!.startupServices)) {
      expect(start, name).not.toHaveBeenCalled();
    }
  });

  // U6 — a managed daemon (Electron's own child) may start with no configured owner token.
  // It mints an in-memory one so the desktop can mint and exchange a one-time pairing code;
  // the value never leaves the daemon.
  it("mints an in-memory owner token for a desktop-hosted managed daemon when none is configured", async () => {
    vi.useFakeTimers();
    process.env.MULTI_AGENT_MODE = "managed";
    delete process.env.MULTI_AGENT_OWNER_TOKEN;
    const host = process as { parentPort?: unknown };
    host.parentPort = { on: () => {}, postMessage: () => {} };
    try {
      const { startServer } = await import("../src/index.js");

      await startServer(7441);

      const token = createDaemonMock.mock.calls[0]?.[0]?.teamControl?.credentials?.ownerToken;
      expect(typeof token).toBe("string");
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(process.env.MULTI_AGENT_OWNER_TOKEN).toBeUndefined();
    } finally { delete host.parentPort; }
  });

  it("does not invent an owner token for a managed daemon with no parent port", async () => {
    vi.useFakeTimers();
    process.env.MULTI_AGENT_MODE = "managed";
    delete process.env.MULTI_AGENT_OWNER_TOKEN;
    const { startServer } = await import("../src/index.js");

    await startServer(7441);

    expect(createDaemonMock.mock.calls[0]?.[0]?.teamControl?.credentials?.ownerToken).toBeNull();
  });

  it("keeps the configured owner token in managed mode", async () => {
    vi.useFakeTimers();
    process.env.MULTI_AGENT_MODE = "managed";
    process.env.MULTI_AGENT_OWNER_TOKEN = "owner-configured-fixture";
    const { startServer } = await import("../src/index.js");

    await startServer(7441);

    expect(createDaemonMock.mock.calls[0]?.[0]?.teamControl?.credentials?.ownerToken).toBe("owner-configured-fixture");
  });

  it("does not invent an owner token outside managed mode", async () => {
    vi.useFakeTimers();
    process.env.MULTI_AGENT_MODE = "legacy";
    delete process.env.MULTI_AGENT_OWNER_TOKEN;
    const { startServer } = await import("../src/index.js");

    await startServer(7441);

    expect(createDaemonMock.mock.calls[0]?.[0]?.teamControl?.credentials?.ownerToken).toBeNull();
  });
});
