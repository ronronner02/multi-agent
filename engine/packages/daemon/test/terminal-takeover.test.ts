import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { registerTerminalWs } from "../src/routes/terminal-ws.js";
import { EventBus } from "../src/domain/event-bus.js";
import { createFullTestDb } from "./helpers/test-app.js";
import {
  TERMINAL_TAKEOVER_IDLE_MS,
  TerminalTakeoverManager,
  type TerminalTakeoverAuditRecord,
} from "../src/domain/terminal-takeover.js";

describe("TerminalTakeoverManager", () => {
  const managers: TerminalTakeoverManager[] = [];

  afterEach(() => {
    for (const manager of managers.splice(0)) manager.dispose();
  });

  function make(now: { value: number }, audit: TerminalTakeoverAuditRecord[] = []) {
    const manager = new TerminalTakeoverManager({
      now: () => now.value,
      audit: record => audit.push(record),
    });
    managers.push(manager);
    return manager;
  }

  it("keeps input read-only until the owner session takes over one target", () => {
    const now = { value: 10 };
    const audit: TerminalTakeoverAuditRecord[] = [];
    const manager = make(now, audit);

    expect(manager.authorizeInput("owner-1", "seat-1")).toBe(false);
    expect(manager.get("seat-1")).toBeUndefined();
    expect(audit.at(-1)).toMatchObject({ action: "input_rejected", ownerSessionId: "owner-1", targetSession: "seat-1" });

    expect(manager.begin("owner-1", "seat-1")).toMatchObject({ ok: true });
    expect(manager.authorizeInput("owner-1", "seat-1")).toBe(true);
    expect(manager.authorizeInput("owner-2", "seat-1")).toBe(false);
    expect(manager.get("seat-1")?.ownerSessionId).toBe("owner-1");
    expect(audit.some(record => record.action === "input_rejected" && record.ownerSessionId === "owner-2")).toBe(true);
  });

  it("ends take-over on release and disconnect, scoped by owner session", () => {
    const now = { value: 100 };
    const manager = make(now);

    expect(manager.begin("owner-a", "seat-a")).toMatchObject({ ok: true });
    expect(manager.begin("owner-b", "seat-b")).toMatchObject({ ok: true });
    expect(manager.release("owner-b", "seat-a")).toBe(false);
    expect(manager.release("owner-a", "seat-a")).toBe(true);
    expect(manager.get("seat-a")).toBeUndefined();
    expect(manager.disconnect("owner-b")).toBe(1);
    expect(manager.list()).toHaveLength(0);
  });

  it("expires after 15 minutes without input and records no terminal bytes", () => {
    const now = { value: 1_000 };
    const audit: TerminalTakeoverAuditRecord[] = [];
    const manager = make(now, audit);
    expect(manager.begin("owner-1", "seat-1")).toMatchObject({ ok: true });

    now.value += TERMINAL_TAKEOVER_IDLE_MS - 1;
    expect(manager.expireInactive()).toBe(0);
    expect(manager.get("seat-1")).toBeDefined();

    now.value += 1;
    expect(manager.expireInactive()).toBe(1);
    expect(manager.get("seat-1")).toBeUndefined();
    expect(audit.at(-1)).toMatchObject({ action: "takeover_expired", ownerSessionId: "owner-1", targetSession: "seat-1" });
    expect(JSON.stringify(audit)).not.toContain("keystroke");
    expect(JSON.stringify(audit)).not.toContain("output");
  });

  it("revokes all take-overs for a session and rejects later input", () => {
    const now = { value: 5_000 };
    const audit: TerminalTakeoverAuditRecord[] = [];
    const manager = new TerminalTakeoverManager({
      now: () => now.value,
      isOwnerSessionActive: sessionId => sessionId !== "revoked-owner",
      audit: record => audit.push(record),
    });
    managers.push(manager);

    expect(manager.begin("revoked-owner", "seat-1")).toMatchObject({ ok: false, code: "owner_session_required" });

    const active = new TerminalTakeoverManager({ now: () => now.value, audit: record => audit.push(record) });
    managers.push(active);
    expect(active.begin("revoked-owner", "seat-1")).toMatchObject({ ok: true });
    // A manager supplied with the session validator closes an already-active takeover on its next input.
    const guarded = new TerminalTakeoverManager({
      now: () => now.value,
      isOwnerSessionActive: sessionId => sessionId !== "revoked-owner",
      audit: record => audit.push(record),
    });
    managers.push(guarded);
    expect(guarded.begin("owner-ok", "seat-2")).toMatchObject({ ok: true });
    expect(guarded.revoke("owner-ok")).toBe(1);
    expect(guarded.authorizeInput("owner-ok", "seat-2")).toBe(false);
    expect(audit.some(record => record.action === "takeover_revoked")).toBe(true);
  });

  it("does not retain timer handles after disposal", () => {
    const manager = make({ value: 10 });
    const clear = vi.spyOn(globalThis, "clearTimeout");
    manager.begin("owner-1", "seat-1");
    manager.dispose();
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });
  it("does not let an inactive caller revoke another owner's takeover", () => {
    const manager = new TerminalTakeoverManager({ isOwnerSessionActive: id => id === "owner-live" });
    managers.push(manager);
    expect(manager.begin("owner-live", "seat-1").ok).toBe(true);
    expect(manager.authorizeInput("worker-1", "seat-1")).toBe(false);
    expect(manager.get("seat-1")?.ownerSessionId).toBe("owner-live");
  });

  it("persists authority before granting it and fails closed when storage rejects the audit", async () => {
    const db = createFullTestDb();
    const manager = new TerminalTakeoverManager({ eventBus: new EventBus(db), audit: async () => { throw new Error("observer failed"); } });
    managers.push(manager);
    try {
      expect(manager.begin("owner-1", "seat-1").ok).toBe(true);
      expect(db.prepare("SELECT payload FROM events WHERE type = 'terminal.takeover.audit'").get()).toMatchObject({ payload: expect.stringContaining("takeover_started") });
      await new Promise(resolve => setTimeout(resolve, 0));
      db.exec("CREATE TEMP TRIGGER reject_audit BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
      expect(() => manager.begin("owner-1", "seat-2")).toThrow("audit unavailable");
      expect(manager.get("seat-2")).toBeUndefined();
      const lastInputAt = manager.get("seat-1")!.lastInputAt;
      expect(() => manager.begin("owner-1", "seat-1", lastInputAt + 1)).toThrow("audit unavailable");
      expect(manager.get("seat-1")?.lastInputAt).toBe(lastInputAt);
    } finally { manager.dispose(); db.close(); }
  });

  it.each(["audit", "eventBus"] as const)("keeps persisted authority consistent during reentrant %s delivery", delivery => {
    const db = createFullTestDb(), eventBus = new EventBus(db);
    let manager: TerminalTakeoverManager, competing: ReturnType<TerminalTakeoverManager["begin"]> | undefined;
    let observedOwner: string | undefined;
    const observer = (record: TerminalTakeoverAuditRecord) => {
      if (record.action !== "takeover_started" || record.ownerSessionId !== "owner-a") return;
      observedOwner = manager.get("seat-1")?.ownerSessionId;
      competing = manager.begin("owner-b", "seat-1", 1001);
    };
    manager = new TerminalTakeoverManager({ eventBus, audit: delivery === "audit" ? observer : undefined });
    if (delivery === "eventBus") eventBus.subscribe(record => observer(record as unknown as TerminalTakeoverAuditRecord));
    managers.push(manager);
    try {
      expect(manager.begin("owner-a", "seat-1", 1000).ok).toBe(true);
      expect(competing).toMatchObject({ ok: false, code: "takeover_active" });
      expect(observedOwner).toBe("owner-a");
      expect(manager.get("seat-1")?.ownerSessionId).toBe("owner-a");
      const rows = db.prepare("SELECT payload FROM events WHERE type = 'terminal.takeover.audit' AND json_extract(payload, '$.action') = 'takeover_started' ORDER BY seq").all() as { payload: string }[];
      expect(rows.map(row => JSON.parse(row.payload))).toMatchObject([{ ownerSessionId: "owner-a", targetSession: "seat-1", at: 1000 }]);
      expect(manager.authorizeInput("owner-b", "seat-1", 1002)).toBe(false);
    } finally { manager.dispose(); db.close(); }
  });

  it.each(["release", "disconnect", "revoked", "inactivity"] as const)("blocks readmission until a failed %s closure is persisted", reason => {
    const db = createFullTestDb(), now = { value: 1_000 };
    const manager = new TerminalTakeoverManager({ now: () => now.value, eventBus: new EventBus(db) });
    managers.push(manager);
    try {
      expect(manager.begin("owner-1", "seat-1").ok).toBe(true);
      db.exec("CREATE TEMP TRIGGER reject_closure BEFORE INSERT ON events WHEN NEW.type = 'terminal.takeover.audit' AND json_extract(NEW.payload, '$.action') IN ('takeover_released', 'takeover_disconnected', 'takeover_revoked', 'takeover_expired') BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
      now.value += reason === "inactivity" ? TERMINAL_TAKEOVER_IDLE_MS : 1;
      const endedAt = now.value;
      const close = () => reason === "release" ? manager.release("owner-1", "seat-1")
        : reason === "disconnect" ? manager.disconnect("owner-1")
        : reason === "revoked" ? manager.revoke("owner-1") : manager.expireInactive();
      expect(close).toThrow("audit unavailable");
      expect(manager.get("seat-1")).toBeUndefined();
      expect(manager.authorizeInput("owner-1", "seat-1")).toBe(false);
      expect(() => manager.begin("owner-2", "seat-1")).toThrow("audit unavailable");
      expect(manager.get("seat-1")).toBeUndefined();
      db.exec("DROP TRIGGER reject_closure");
      now.value += 10;
      expect(manager.begin("owner-2", "seat-1").ok).toBe(true);
      const rows = db.prepare("SELECT payload FROM events WHERE type = 'terminal.takeover.audit' ORDER BY seq").all() as { payload: string }[];
      const records = rows.map(row => JSON.parse(row.payload) as TerminalTakeoverAuditRecord);
      const action = reason === "release" ? "takeover_released" : reason === "disconnect" ? "takeover_disconnected"
        : reason === "revoked" ? "takeover_revoked" : "takeover_expired";
      expect(records.slice(-2)).toMatchObject([
        { action, ownerSessionId: "owner-1", targetSession: "seat-1", at: endedAt },
        { action: "takeover_started", ownerSessionId: "owner-2", targetSession: "seat-1" },
      ]);
    } finally { manager.dispose(); db.close(); }
  });

  it.each(["disconnect", "revoked", "inactivity"] as const)("disables every affected target before a %s audit fails", reason => {
    const db = createFullTestDb(), now = { value: 1_000 };
    const manager = new TerminalTakeoverManager({ now: () => now.value, eventBus: new EventBus(db) });
    managers.push(manager);
    try {
      manager.begin("owner-1", "seat-1"); manager.begin("owner-1", "seat-2");
      now.value += 1;
      manager.begin("owner-2", "seat-3");
      db.exec("CREATE TEMP TRIGGER reject_closure BEFORE INSERT ON events WHEN NEW.type = 'terminal.takeover.audit' AND json_extract(NEW.payload, '$.action') IN ('takeover_disconnected', 'takeover_revoked', 'takeover_expired') BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
      if (reason === "inactivity") now.value = 1_000 + TERMINAL_TAKEOVER_IDLE_MS;
      expect(() => reason === "disconnect" ? manager.disconnect("owner-1")
        : reason === "revoked" ? manager.revoke("owner-1") : manager.expireInactive()).toThrow("audit unavailable");
      expect(manager.get("seat-1")).toBeUndefined();
      expect(manager.get("seat-2")).toBeUndefined();
      expect(manager.authorizeInput("owner-2", "seat-3")).toBe(true);
      for (const target of ["seat-1", "seat-2"]) {
        expect(() => manager.begin("owner-2", target)).toThrow("audit unavailable");
      }
      db.exec("DROP TRIGGER reject_closure");
      expect(manager.begin("owner-2", "seat-1").ok).toBe(true);
      expect(manager.begin("owner-2", "seat-2").ok).toBe(true);
    } finally { manager.dispose(); db.close(); }
  });

  it("contains timer audit errors while keeping expired authority disabled and readmission blocked", () => {
    vi.useFakeTimers();
    const db = createFullTestDb(), now = { value: 1_000 };
    const manager = new TerminalTakeoverManager({ now: () => now.value, eventBus: new EventBus(db) });
    managers.push(manager);
    try {
      manager.begin("owner-1", "seat-1");
      db.exec("CREATE TEMP TRIGGER reject_closure BEFORE INSERT ON events WHEN NEW.type = 'terminal.takeover.audit' AND json_extract(NEW.payload, '$.action') = 'takeover_expired' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
      now.value += TERMINAL_TAKEOVER_IDLE_MS;
      expect(() => vi.advanceTimersByTime(TERMINAL_TAKEOVER_IDLE_MS)).not.toThrow();
      expect(manager.get("seat-1")).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      expect(() => manager.begin("owner-2", "seat-1")).toThrow("audit unavailable");
      db.exec("DROP TRIGGER reject_closure");
      expect(manager.begin("owner-2", "seat-1").ok).toBe(true);
    } finally { manager.dispose(); db.close(); vi.useRealTimers(); }
  });

  it("contains a failed disconnect audit in the WebSocket close callback", async () => {
    const db = createFullTestDb(), manager = new TerminalTakeoverManager({ eventBus: new EventBus(db) });
    managers.push(manager);
    const app = new Hono();
    const upgrade = (factory: (c: any) => any) => async (c: any) => {
      const handler = factory(c), owner = c.get("terminalActor").sessionId;
      expect(manager.begin(owner, "seat-1").ok).toBe(true);
      db.exec("CREATE TEMP TRIGGER reject_disconnect BEFORE INSERT ON events WHEN NEW.type = 'terminal.takeover.audit' AND json_extract(NEW.payload, '$.action') = 'takeover_disconnected' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
      await expect(handler.onClose()).resolves.toBeUndefined();
      expect(manager.get("seat-1")).toBeUndefined();
      expect(() => manager.begin(owner, "seat-1")).toThrow("audit unavailable");
      return c.text("finished");
    };
    registerTerminalWs(app, upgrade as never, { bearerToken: "legacy-terminal", managed: true,
      credentials: { ownerToken: "owner-token", workers: [] }, takeoverManager: manager });
    try {
      const response = await app.request("/api/terminal/seat-1", { headers: { Authorization: "Bearer owner-token" } });
      expect(response.status).toBe(200);
    } finally { manager.dispose(); db.close(); }
  });

  it.each(["legacy-terminal", "worker-token"])("refuses the legacy terminal credential on the owner relay (%s)", async token => {
    const app = new Hono();
    const input = vi.fn(async () => {}), attach = vi.fn(async () => ({ sendInput: input, close: async () => {} }));
    const socket = { send: vi.fn(), close: vi.fn() };
    const upgrade = (factory: (c: unknown) => any) => async (c: any) => {
      const handler = factory(c);
      await handler.onOpen({}, socket);
      await handler.onMessage({ data: JSON.stringify({ type: "input", data: "owner-only-input" }) }, socket);
      await handler.onClose();
      return c.text("finished");
    };
    registerTerminalWs(app, upgrade as never, { bearerToken: "legacy-terminal", managed: true,
      credentials: { ownerToken: "owner-token", workers: [{ token: "worker-token", sessionId: "worker-1", runId: "run-1" }] },
      ownerTerminalHost: { isAvailable: async () => true, attach } });
    await app.request("/api/terminal/owner", { headers: { Authorization: `Bearer ${token}` } });
    expect(socket.close).toHaveBeenCalledWith(1008, "owner control required");
    expect(attach).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
  });

});
