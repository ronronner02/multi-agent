import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const UI_INDEX_HTML = "<!doctype html><html><body><div id=\"root\">Multi-Agent UI</div></body></html>";

function createTempUiDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "u22-ui-dist-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), UI_INDEX_HTML, "utf8");
  writeFileSync(join(dir, "assets", "app.js"), "console.log('multi-agent');", "utf8");
  return dir;
}

function appWithUi(db: ReturnType<typeof createFullTestDb>, uiDistDir: string) {
  return createTestApp(db, { appDeps: { uiDistDir, webUiEnabled: true } }).app;
}

describe("Hono server (production app)", () => {
  it("GET /healthz returns 200 with status ok", async () => {
    const db = createFullTestDb();
    try {
      const { app } = createTestApp(db);
      const res = await app.request("/healthz");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "ok", pid: process.pid });
    } finally {
      db.close();
    }
  });

  it("unknown API routes return the JSON 404 contract for every method", async () => {
    const db = createFullTestDb();
    const uiDistDir = createTempUiDist();
    try {
      const app = appWithUi(db, uiDistDir);
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
        for (const requestPath of ["/api/unknown", "/api/unknown/deep"]) {
          const res = await app.request(requestPath, { method });
          expect(res.status, `${method} ${requestPath}`).toBe(404);
          expect(res.headers.get("content-type"), `${method} ${requestPath}`).toContain("application/json");
          const text = await res.text();
          expect(text).not.toContain("Multi-Agent UI");
          if (method === "HEAD") expect(text).toBe("");
          else expect(JSON.parse(text)).toEqual({ error: "not_found", path: requestPath });
        }
      }
    } finally {
      rmSync(uiDistDir, { recursive: true, force: true });
      db.close();
    }
  });

  it("serves index.html for root and SPA deep links when a UI bundle exists", async () => {
    const db = createFullTestDb();
    const uiDistDir = createTempUiDist();
    try {
      const app = appWithUi(db, uiDistDir);
      for (const requestPath of ["/", "/team", "/team/tasks", "/api", "/apiX", "/healthz-adjacent"]) {
        const res = await app.request(requestPath);
        expect(res.status, requestPath).toBe(200);
        expect(res.headers.get("content-type"), requestPath).toContain("text/html");
        expect(await res.text(), requestPath).toBe(UI_INDEX_HTML);
      }
    } finally {
      rmSync(uiDistDir, { recursive: true, force: true });
      db.close();
    }
  });

  it("serves built assets directly when a UI bundle exists", async () => {
    const db = createFullTestDb();
    const uiDistDir = createTempUiDist();
    try {
      const app = appWithUi(db, uiDistDir);
      const res = await app.request("/assets/app.js");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/javascript");
      expect(await res.text()).toContain("console.log('multi-agent');");
    } finally {
      rmSync(uiDistDir, { recursive: true, force: true });
      db.close();
    }
  });
});
