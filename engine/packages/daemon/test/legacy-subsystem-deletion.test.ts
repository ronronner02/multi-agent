import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createDaemon } from "../src/startup.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
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
      tmuxExec: async () => "",
      teamControl: { credentials: { ownerToken: "deletion-owner" } },
    });
    try {
      const routes = daemon.app.routes.map(route => `${route.method} ${route.path}`);
      expect(routes.some(route => route.includes("/api/team-control"))).toBe(true);
      expect(routes).toContain("GET /api/team-control/teams");
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
  ])("returns 404 for deleted route %s %s", async (method, path) => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
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
    const deletedModules = /gateway\/slack|cmux|rig-cmux|domain\/topology\/|domain\/mission-control\/|routes\/(?:hosts|mission-control)\.|domain\/hosts\/(?:fanout-contract|read-through|hosts-registry-writer)\.|components\/(?:mission-control|for-you)\/|components\/topology\/(?:ScopePages|TopologyTreeView|TopologyTableView|TopologyTerminalView|TopologyViewModeTabs|TerminalLauncher)\.|components\/(?:HostIndicator|RigStatusControl|dashboard\/HostConfigCard)\.|commands\/host\./i;

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
