import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createDaemon } from "../src/startup.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createTestApp } from "./helpers/test-app.js";

describe("legacy gateway and cmux deletion", () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  it("starts the daemon with retained team routes mounted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "legacy-deletion-")); directories.push(directory);
    const daemon = await createDaemon({ dbPath: join(directory, "daemon.sqlite"), managedMode: true, tmuxExec: async () => "", teamControl: { credentials: { ownerToken: "deletion-owner" } } });
    try {
      const routes = new Set(daemon.app.routes.map(route => `${route.method} ${route.path}`));
      expect([...routes].some((route) => route.includes("/api/team-control"))).toBe(true);
      expect([...routes]).toContain("GET /api/team-control/teams");
    } finally { daemon.eventLoopMonitor.stop(); daemon.db.close(); }
  });

  it.each([["GET", "/api/gateway/connections"], ["GET", "/api/adapters/cmux/status"], ["POST", "/api/rigs/deleted/cmux/launch"], ["POST", "/api/rigs/deleted/nodes/deleted/open-cmux"]])("returns 404 for deleted route %s %s", async (method, path) => {
    const db = createDb(); migrate(db, ALL_MIGRATIONS);
    try { const { app } = createTestApp(db); expect((await app.request(`http://localhost${path}`, { method, headers: { Host: "localhost" } })).status).toBe(404); }
    finally { db.close(); }
  });

  it("has no deleted subsystem imports in package sources", () => {
    const packages = fileURLToPath(new URL("../../", import.meta.url)); const matches: string[] = [];
    function scan(directory: string): void {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) scan(file);
        else if (/\.[cm]?[jt]sx?$/.test(file)) {
          const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
          function visit(node: ts.Node): void {
            const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
            if (specifier && ts.isStringLiteralLike(specifier) && /gateway\/slack|cmux|rig-cmux/i.test(specifier.text)) matches.push(`${file}:${source.getLineAndCharacterOfPosition(specifier.getStart(source)).line + 1}: ${specifier.text}`);
            ts.forEachChild(node, visit);
          }
          visit(source);
        }
      }
    }
    for (const entry of readdirSync(packages, { withFileTypes: true })) if (entry.isDirectory() && ["daemon", "ui", "cli", "i18n"].includes(entry.name)) scan(join(packages, entry.name, "src"));
    expect(matches).toEqual([]);
  });
});
