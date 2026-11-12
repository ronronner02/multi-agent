import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createDaemon } from "../src/startup.js";
import { createDb } from "../src/db/connection.js";
import { initializeDatabase } from "../src/db/baseline.js";
import { createTestApp } from "./helpers/test-app.js";

describe("legacy subsystem deletion", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("starts the daemon with retained team routes mounted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "legacy-deletion-"));
    directories.push(directory);
    const daemon = await createDaemon({
      dbPath: join(directory, "daemon.sqlite"),
      managedMode: true,
      teamControl: { credentials: { ownerToken: "deletion-owner" } },
    });
    try {
      const routes = daemon.app.routes.map(route => `${route.method} ${route.path}`);
      expect(routes.some(route => route.includes("/api/team-control"))).toBe(true);
      expect(routes).toContain("GET /api/team-control/teams");
      expect(routes).toContain("POST /api/team-control/github/login/stop");
    } finally {
      daemon.eventLoopMonitor.stop();
      daemon.db.close();
    }
  });

  it.each([
    ["GET", "/api/gateway/connections"],
    ["GET", "/api/adapters/cmux/status"],
    ["POST", "/api/rigs/deleted/cmux/launch"],
    ["POST", "/api/rigs/deleted/nodes/deleted/open-cmux"],
    ["GET", "/api/topology"],
    ["GET", "/api/topology/rigs"],
    ["GET", "/api/mission-control"],
    ["GET", "/api/mission-control/views"],
    ["GET", "/api/mission-control/views/my-queue"],
    ["POST", "/api/mission-control/action"],
    ["POST", "/api/mission-control/notifications/test"],
    ["GET", "/api/hosts"],
    ["POST", "/api/hosts/add"],
    ["POST", "/api/hosts/pair"],
    ["GET", "/api/rigs/deleted/snapshots"],
    ["POST", "/api/rigs/deleted/restore"],
    ["POST", "/api/crash-cart"],
    ["POST", "/api/rigs/import"],
    ["GET", "/api/rigs/deleted/spec"],
    ["GET", "/api/rigs/deleted/spec.json"],
    ["GET", "/api/packages"],
    ["POST", "/api/bootstrap"],
    ["GET", "/api/discovery"],
    ["GET", "/api/bundles"],
    ["GET", "/api/specs/review"],
    ["GET", "/api/specs/library"],
    ["GET", "/api/plugins"],
    ["GET", "/api/skills"],
    ["GET", "/api/config"],
    ["GET", "/api/context-packs"],
    ["GET", "/api/agent-images"],
    ["GET", "/api/watchdog"],
    ["GET", "/api/health-summary"],
    ["GET", "/api/attention"],
    ["GET", "/api/health-diagnosis"],
    ["GET", "/api/restore-check"],
    ["GET", "/api/activity"],
    ["GET", "/api/activity/hooks"],
    ["GET", "/api/activity/events"],
    ["GET", "/api/terminal"],
    ["GET", "/api/terminal/views"],
    ["POST", "/api/terminal/open"],
    ["GET", "/api/terminal/ws"],
    ["GET", "/api/seat"],
    ["GET", "/api/seat/status/foo"],
    ["POST", "/api/seat/continue/foo"],
    ["GET", "/api/activity/parked"],
    ["GET", "/api/attention"],
    ["GET", "/api/chat"],
    ["POST", "/api/compaction"],
    ["GET", "/api/env"],
    ["GET", "/api/files"],
    ["GET", "/api/missions"],
    ["GET", "/api/progress"],
    ["GET", "/api/projects"],
    ["GET", "/api/proof"],
    ["GET", "/api/provider"],
    ["GET", "/api/ps"],
    ["GET", "/api/queue"],
    ["GET", "/api/review"],
    ["GET", "/api/rig-mode"],
    ["GET", "/api/scopes"],
    ["GET", "/api/sessions"],
    ["GET", "/api/steering"],
    ["GET", "/api/stream"],
    ["GET", "/api/telemetry"],
    ["GET", "/api/transcripts"],
    ["GET", "/api/transport"],
    ["GET", "/api/views"],
    ["GET", "/api/wake-resolve"],
    ["GET", "/api/whoami"],
    ["GET", "/api/workflow"],
  ])("returns 404 for deleted route %s %s", async (method, path) => {
    const db = createDb();
    initializeDatabase(db);
    try {
      const { app } = createTestApp(db);
      const response = await app.request(`http://localhost${path}`, {
        method,
        headers: { Host: "localhost" },
      });
      expect(response.status).toBe(404);
    } finally {
      db.close();
    }
  });

  it("has no deleted subsystem imports in package sources", () => {
    const packages = fileURLToPath(new URL("../../", import.meta.url));
    const matches: string[] = [];
    const deletedModules = /(?:adapters\/(?:tmux(?:-[^/]+)?|terminal-adapter)|domain\/(?:terminal|seat-[^/]+|session-transport)|routes\/(?:terminal|terminal-ws|seat|activity-hooks))\.|gateway\/slack|cmux|rig-cmux|domain\/(?:topology|mission-control|review|feed|model-divergence|scope)\/|routes\/(?:adapters|agents|activity|attention|bootstrap|bundles|chat|compaction|config|context-packs|crash-cart|discovery|down|env|files|health|health-diagnosis|health-summary|info|kernel-status|missions|packages|plugins|progress|projects|proof|provider|ps|queue|restore-check|review|rig-mode|rigspec|rigs|scope-approve|scope-audit|scopes|sessions|skills|slices|snapshots|spec-review|spec-library|startup|steering|stream|telemetry|transcripts|transport|up|views|wake-resolve|watchdog|whoami|workflow)\.|domain\/(?:snapshot-repository|snapshot-capture|checkpoint-store|restore-orchestrator|periodic-snapshot-scheduler|package-repository|install-repository|install-engine|install-verifier|package-install-service|bootstrap-repository|bootstrap-orchestrator|external-install-planner|external-install-executor|runtime-verifier|bundle-source-resolver|bundle-identity|bundle-behaviour|bundle-content-routing|discovery-coordinator|tmux-discovery-scanner|session-fingerprinter|session-enricher|rigspec-exporter|rigspec-preflight|rigspec-instantiator|rig-expansion-service|rig-teardown|up-command-router|ps-projection|watchdog-policy-engine|watchdog-scheduler|watchdog-auto-registration|spec-library-service|spec-library-workflow-scanner|spec-review-service|plugin-discovery-service|skill-library-discovery|health-diagnosis|health-detectors|health-policy|health-checkpoints|health-passive-ceremony|health-context|health-projection|permission-drift-observer|model-divergence-monitor|remote-daemon-http|settings-browser)\.|domain\/(?:bundle|review|scope|steering|proof|crash-cart|model-divergence|workflow\/slice)\/|components\/(?:mission-control|for-you)\/|components\/topology\/(?:ScopePages|TopologyTreeView|TopologyTableView|TopologyTerminalView|TopologyViewModeTabs|TerminalLauncher)\.|components\/(?:HostIndicator|RigStatusControl|dashboard\/HostConfigCard)\.|commands\/host\./i;

    function scan(directory: string): void {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) {
          scan(file);
        } else if (/\.[cm]?[jt]sx?$/.test(file)) {
          const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
          function visit(node: ts.Node): void {
            const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
              ? node.moduleSpecifier
              : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
                ? node.arguments[0]
                : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
                  ? node.argument.literal
                  : undefined;
            if (specifier && ts.isStringLiteralLike(specifier) && deletedModules.test(specifier.text)) {
              const line = source.getLineAndCharacterOfPosition(specifier.getStart(source)).line + 1;
              matches.push(`${file}:${line}: ${specifier.text}`);
            }
            ts.forEachChild(node, visit);
          }
          visit(source);
        }
      }
    }

    for (const entry of readdirSync(packages, { withFileTypes: true })) {
      const sourceDirectory = join(packages, entry.name, "src");
      if (entry.isDirectory() && existsSync(sourceDirectory)) scan(sourceDirectory);
    }
    expect(matches).toEqual([]);
  });
});
