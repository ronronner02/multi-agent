// Refusals on the real route table must prevent both handler calls and database writes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

describe("browser boundary on the real route table", () => {
  let db: Database.Database;
  beforeEach(() => { db = createFullTestDb(); });
  afterEach(() => { db.close(); });

  function build(extra: Record<string, unknown> = {}) {
    const opens: unknown[] = [], previews: unknown[] = [];
    const decisions: Array<{ outcome: string; code?: string }> = [];
    const setup = createTestApp(db, {
      withWebSocket: true,
      appDeps: {
        terminalService: {
          openView: async (req: unknown) => { opens.push(req); return { ok: true }; },
          previewView: async (req: unknown) => { previews.push(req); return { ok: true }; },
          listViews: async () => [],
        } as never,
        browserBoundaryObserver: (d) => decisions.push(d),
        ...extra,
      },
    });
    const rig = setup.rigRepo.createRig("fixture");
    const node = setup.rigRepo.addNode(rig.id, "dev", { runtime: "claude-code", model: "fable" });
    setup.sessionRegistry.registerSession(node.id, "dev@fixture");
    const model = () => (db.prepare("SELECT model FROM nodes WHERE id = ?").get(node.id) as { model: string }).model;
    return { ...setup, opens, previews, decisions, model };
  }

  const req = (app: { request: (p: string, i: RequestInit) => Response | Promise<Response> }, p: string, h: Record<string, string>, method = "GET", body?: unknown) =>
    app.request(p, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...h }, ...(body ? { body: JSON.stringify(body) } : {}) });

  it("POST /api/terminal/open: refused origin or target reaches no handler; admitted reaches it once", async () => {
    const b = build(), body = { view: "rig:fixture" };
    for (const h of [
      { Host: "evil.example:7433", Origin: "http://evil.example:7433" },
      { Host: "127.0.0.1:7433", Origin: "http://evil.example" },
      { Host: "127.0.0.1:7433", Origin: "null" },
      { Host: "unknown.example:7433" },
    ]) {
      const res = await req(b.app, "/api/terminal/open", h, "POST", body);
      expect(res.status, JSON.stringify(h)).toBe(403);
    }
    expect(b.opens).toHaveLength(0);
    expect((await req(b.app, "/api/terminal/open", { Host: "127.0.0.1:7433" }, "POST", body)).status).toBe(200);
    expect(b.opens).toEqual([body]);
    expect(b.decisions).toHaveLength(5);
  });

  it("GET /api/terminal/preview: a no-Origin read addressed to an attacker name reaches no handler", async () => {
    const b = build();
    expect((await req(b.app, "/api/terminal/preview?view=x", { Host: "evil.example:7433" })).status).toBe(403);
    expect((await req(b.app, "/api/terminal/preview?view=x", { Host: "evil.example:7433", "Sec-Fetch-Site": "same-origin" })).status).toBe(403);
    expect(b.previews).toHaveLength(0);
    await req(b.app, "/api/terminal/preview?view=x", { Host: "localhost:7433" });
    expect(b.previews).toHaveLength(1);
  });

  it("POST /api/seat/set-model: a refused request writes no row; an admitted one updates the seat", async () => {
    const b = build(), body = { model: "claude-fable-5", reason: "fixture" };
    const refused = await req(b.app, "/api/seat/set-model/dev@fixture", { Host: "127.0.0.1:7433", Origin: "http://evil.example", "X-OpenRig-Session": "owner@fixture" }, "POST", body);
    expect(refused.status).toBe(403);
    expect(b.model()).toBe("fable");
    const ok = await req(b.app, "/api/seat/set-model/dev@fixture", { Host: "127.0.0.1:7433", "X-OpenRig-Session": "owner@fixture" }, "POST", body);
    expect(ok.status).toBe(200);
    expect(b.model()).toBe("claude-fable-5");
  });

  it("UI on admits the own UI origin through the real table; a token never waives an origin refusal", async () => {
    const b = build({ webUiEnabled: true, terminalBearerToken: "tok-1" });
    expect((await req(b.app, "/api/terminal/views", { Host: "localhost:7433", Origin: "http://localhost:7433", Authorization: "Bearer tok-1" })).status).toBe(200);
    expect((await req(b.app, "/api/terminal/views", { Host: "custom.example:7433", Authorization: "Bearer tok-1" })).status).toBe(200);
    const r = await req(b.app, "/api/terminal/views", { Host: "custom.example:7433", Authorization: "Bearer tok-1", Origin: "http://evil.example" });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { code: string }).code).toBe("browser_origin_refused");
  });

  it("a waived target name keeps downstream route authorization: wrong-route token still refused by the route", async () => {
    const b = build({ legacyBearerToken: "mc-token", terminalBearerToken: "term-token" });
    const r = await req(b.app, "/api/terminal/preview?view=x", { Host: "custom.example:7433", Authorization: "Bearer mc-token" });
    expect(r.status).toBe(401);
    expect(b.previews).toHaveLength(0);
    expect((await req(b.app, "/api/terminal/preview?view=x", { Host: "custom.example:7433", Authorization: "Bearer term-token" })).status).toBe(200);
    expect(b.previews).toHaveLength(1);
  });
});
