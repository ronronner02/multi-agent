import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StatusDeps } from "../src/commands/status.js";
import { importGitHubBundle, prepareGitHubBundle } from "../src/lib/bundle-source.js";

vi.mock("../src/local-origin.js", () => ({ readLocalOrigin: () => "synthetic-instance" }));
vi.mock("../src/host-selection.js", () => ({ resolveEffectiveHost: () => undefined }));
vi.mock("../src/daemon-lifecycle.js", () => ({ getDaemonStatus: async () => ({ state: "running", healthy: true }), getDaemonUrl: () => "http://fixture.invalid" }));

// The CLI must reject outside package references before contacting the deleted bundle endpoint.
describe("GitHub legacy package containment", () => {
  it.each(["absolute", "relative", "local", "include"])("refuses outside legacy package: %s", async mode => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-link-fixture-"));
    const imports = path.join(root, "imports");
    const marker = "SYNTHETIC_OUTSIDE_PACKAGE_BYTES";
    const sha = "a".repeat(40);
    try {
      const post = vi.fn(async () => { throw new Error("bundle create must not be reached"); });
      let includePackages: string[] | undefined;
      const client = {
        get: async () => ({ status: 200, data: { selfHostId: "synthetic-instance" } }),
        post,
      };
      const git = async (checkout: string, args: string[]) => {
        if (args[0] === "ls-remote") return `${sha}\tHEAD\n${sha}\trefs/heads/main\n`;
        if (args[0] === "rev-parse") return sha;
        if (args[0] === "checkout") {
          const folder = path.join(checkout, "rigs/dev");
          const pkg = path.join(root, "host-package");
          fs.mkdirSync(folder, { recursive: true });
          fs.mkdirSync(path.join(pkg, "skills/helper"), { recursive: true });
          fs.writeFileSync(path.join(pkg, "package.yaml"), 'schema_version: 1\nname: fixture-package\nversion: "1.0.0"\nsummary: Synthetic fixture\ncompatibility:\n  runtimes: [claude-code]\nexports:\n  skills:\n    - source: skills/helper\n      name: helper\n      supported_scopes: [project_shared]\n      default_scope: project_shared\n');
          fs.writeFileSync(path.join(pkg, "skills/helper/SKILL.md"), marker);
          const ref = mode === "relative" ? path.relative(folder, pkg) : mode === "local" ? `local:${path.relative(folder, pkg)}` : pkg;
          if (mode === "include") includePackages = [ref];
          fs.writeFileSync(path.join(folder, "rig.yaml"), `schema_version: 1\nname: legacy-link-fixture\nversion: "1.0"\nnodes:\n  - id: dev\n    runtime: claude-code\n    package_refs: ${JSON.stringify(mode === "include" ? [] : [ref])}\nedges: []\n`);
        }
        return "";
      };
      // Preparation runs inside import; expose the CLI option only after the synthetic checkout selects its path.
      const opts: { includePackages?: string[] } = {};
      let error: unknown;
      try {
        await importGitHubBundle("https://github.com/example/fixture/tree/main/rigs/dev",
          { lifecycleDeps: {}, clientFactory: () => client } as unknown as StatusDeps, opts, async link => {
            const prepared = await prepareGitHubBundle(link, git, imports);
            opts.includePackages = includePackages;
            return prepared;
          });
      } catch (err) { error = err; }
      expect(post).not.toHaveBeenCalled();
      expect(String(error)).toMatch(/refs must resolve inside the fetched repository/);
      expect(fs.readdirSync(imports)).toEqual([]);
      expect(fs.readFileSync(path.join(root, "host-package/skills/helper/SKILL.md"), "utf8")).toBe(marker);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
