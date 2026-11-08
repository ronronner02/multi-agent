// KTD22 keeps legacy pages out of a managed daemon. The managed team view is served by the
// same bundle, so its entry routes and assets stay reachable while every other page keeps the
// refusal. Without this the desktop window has nothing to show: the daemon it starts is
// always managed.
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { createFullTestDb, createTestApp, mockTmuxAdapter, unavailableCmuxAdapter } from "./helpers/test-app.js";
import { createApp, type AppDeps } from "../src/server.js";
import { fixDaemonMode } from "../src/domain/plan-governance.js";

const INDEX_HTML = "<!doctype html><html><head><title>Multi-Agent</title></head><body><div id=\"root\"></div></body></html>";
const LEGACY_REFUSAL = "Legacy pages are inactive in a managed-mode daemon.";
const TERMINAL_BEARER = "managed-team-page-terminal-bearer";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function managedApp(webUiEnabled: boolean, { managed = true, terminalBearerToken }: { managed?: boolean; terminalBearerToken?: string } = {}) {
  const db = createFullTestDb();
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "managed-team-page-"));
  fs.mkdirSync(nodePath.join(dir, "assets"));
  fs.writeFileSync(nodePath.join(dir, "index.html"), INDEX_HTML, "utf-8");
  fs.writeFileSync(nodePath.join(dir, "assets", "app.js"), "console.log('ui');", "utf-8");
  const skin = nodePath.join(dir, "skins", "shuimo-danqing");
  fs.mkdirSync(skin, { recursive: true });
  fs.writeFileSync(nodePath.join(skin, "shuimo-danqing-loop.mp4"), "fixture-video");
  fs.writeFileSync(nodePath.join(skin, "shuimo-danqing-still.webp"), "fixture-poster");
  fs.writeFileSync(nodePath.join(skin, "unrelated.mp4"), "not-a-team-asset");
  cleanups.push(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const s = createTestApp(db) as unknown as Record<string, unknown>;
  const deps = {
    rigRepo: s.rigRepo, sessionRegistry: s.sessionRegistry, eventBus: s.eventBus, nodeLauncher: s.nodeLauncher,
    tmuxAdapter: s.tmuxAdapter ?? mockTmuxAdapter(), cmuxAdapter: s.cmuxAdapter ?? unavailableCmuxAdapter(),
    snapshotCapture: s.snapshotCapture, snapshotRepo: s.snapshotRepo, restoreOrchestrator: s.restoreOrchestrator,
    rigSpecExporter: s.rigSpecExporter, rigSpecPreflight: s.rigSpecPreflight, rigInstantiator: s.rigInstantiator,
    packageRepo: s.packageRepo, installRepo: s.installRepo, installEngine: s.installEngine, installVerifier: s.installVerifier,
    bootstrapOrchestrator: s.bootstrapOrchestrator, bootstrapRepo: s.bootstrapRepo, discoveryCoordinator: s.discoveryCoordinator,
    discoveryRepo: s.discoveryRepo, claimService: s.claimService, psProjectionService: s.psProjectionService, upRouter: s.upRouter,
    teardownOrchestrator: s.teardownOrchestrator, podInstantiator: s.podInstantiator, podBundleSourceResolver: s.podBundleSourceResolver,
    uiDistDir: dir, webUiEnabled, terminalBearerToken,
  } as AppDeps;
  fixDaemonMode(db, managed);
  return createApp(deps);
}

describe("managed-mode team page", () => {
  it.each([
    { path: "/skins/shuimo-danqing/shuimo-danqing-loop.mp4", mime: "video/mp4", bytes: "fixture-video" },
    { path: "/skins/shuimo-danqing/shuimo-danqing-still.webp", mime: "image/webp", bytes: "fixture-poster" },
  ])("serves the command-center media at $path as $mime", async ({ path, mime, bytes }) => {
    const app = managedApp(true);
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(mime);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(bytes));
  });

  it.each([
    { range: "bytes=0-3", body: "fixt", contentRange: "bytes 0-3/13" },
    { range: "bytes=8-", body: "video", contentRange: "bytes 8-12/13" },
    { range: "bytes=-5", body: "video", contentRange: "bytes 8-12/13" },
    { range: "bytes=8-100", body: "video", contentRange: "bytes 8-12/13" },
  ])("serves the exact video range $range for seeking", async ({ range, body, contentRange }) => {
    const response = await managedApp(true).request("/skins/shuimo-danqing/shuimo-danqing-loop.mp4", { headers: { Range: range } });
    expect(response.status).toBe(206);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-range")).toBe(contentRange);
    expect(response.headers.get("content-length")).toBe(String(body.length));
    expect(await response.text()).toBe(body);
  });

  it.each(["bytes=13-", "bytes=5-2", "bytes=-0", "bytes=0-1,4-5", "bytes=99999999999999999999-", "bytes=-"]) (
    "rejects unsatisfiable or unsupported video range %s", async range => {
      const response = await managedApp(true).request("/skins/shuimo-danqing/shuimo-danqing-loop.mp4", { headers: { Range: range } });
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe("bytes */13");
      expect(await response.text()).toBe("");
    });

  it("advertises video seeking on full reads and handles HEAD without a body", async () => {
    const app = managedApp(true);
    const full = await app.request("/skins/shuimo-danqing/shuimo-danqing-loop.mp4");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("content-length")).toBe("13");
    const head = await app.request("/skins/shuimo-danqing/shuimo-danqing-loop.mp4", { method: "HEAD", headers: { Range: "bytes=0-3" } });
    expect(head.status).toBe(206);
    expect(head.headers.get("content-length")).toBe("4");
    expect(await head.text()).toBe("");
  });

  it("keeps non-video assets and managed UI admission unchanged for range requests", async () => {
    const response = await managedApp(true).request("/assets/app.js", { headers: { Range: "bytes=0-1" } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("console.log('ui');");
    expect((await managedApp(false).request("/skins/shuimo-danqing/shuimo-danqing-loop.mp4", { headers: { Range: "bytes=0-1" } })).status).toBe(404);
    expect((await managedApp(true).request("/skins/shuimo-danqing/unrelated.mp4", { headers: { Range: "bytes=0-1" } })).status).toBe(404);
  });

  it("serves the team view and its assets when the web UI is on", async () => {
    const app = managedApp(true);
    for (const path of ["/team", "/team/overview"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toBe(INDEX_HTML);
    }
    expect((await app.request("/assets/app.js")).status).toBe(200);
  });

  it("still refuses every other page in managed mode", async () => {
    const app = managedApp(true);
    for (const path of ["/", "/index.html", "/specs", "/settings", "/topology", "/rigs/rig-1/nodes/dev.impl",
      "/skins", "/skins/shuimo-danqing/", "/skins/shuimo-danqing/unrelated.mp4"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toBe(LEGACY_REFUSAL);
    }
  });

  it("keeps the team view off while the web UI setting is off", async () => {
    const app = managedApp(false);
    for (const path of ["/team", "/skins/shuimo-danqing/shuimo-danqing-loop.mp4", "/skins/shuimo-danqing/shuimo-danqing-still.webp"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("x-openrig-web-ui"), path).toBe("off");
    }
  });

  // A managed daemon serves its team view to any local process, so the page it hands out
  // must not carry the terminal bearer; the paired owner session is the managed credential.
  it("never embeds the terminal bearer in the managed team page", async () => {
    const app = managedApp(true, { terminalBearerToken: TERMINAL_BEARER });
    for (const path of ["/team", "/team/overview"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).not.toContain(TERMINAL_BEARER);
    }
  });

  // The legacy page keeps the behaviour it shipped with.
  it("still embeds the terminal bearer in a legacy-mode page", async () => {
    const app = managedApp(true, { managed: false, terminalBearerToken: TERMINAL_BEARER });
    const res = await app.request("/specs");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(TERMINAL_BEARER);
  });
});

