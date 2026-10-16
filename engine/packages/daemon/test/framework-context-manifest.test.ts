import { afterEach, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareTeamAssignment } from "../src/domain/team-assignment.js";
import { hashBytes } from "../src/domain/plan-governance.js";
import { createContextManifest, verifyEffectiveContext, roleConfiguration, leadProtocol, type ContextInput } from "../src/integrations/framework/context-manifest.js";
import { canonicalJson } from "../src/contracts/team-control.js";
import { FRAMEWORK_PIN } from "../src/integrations/framework/catalog.js";
const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) { chmodSync(join(p, "context"), 0o755); rmSync(p, { recursive: true, force: true }); } });
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "context-test-")); roots.push(base); chmodSync(base, 0o755);
  for (const d of ["repo", "context", "state", "framework"]) mkdirSync(join(base, d));
  const root = join(base, "context"), plan = "approved plan\n";
  const binding: ContextInput["binding"] = { artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active", planRef: "plan.md", planDigest: hashBytes(plan), repository: { root: join(base, "repo"), identity: "git:" + "a".repeat(40) }, readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"], policyRevision: 2, policyFingerprint: hashBytes("policy"), limits: { maxSessions: 3, maxActiveMs: 60000, maxRetries: 1, maxReviewRounds: 2 } };
  const source = join(base, "framework", "skill.md"); writeFileSync(source, "pinned instructions"); writeFileSync(join(base, "repo", "plan.md"), plan);
  const files = ([ ["framework", "pinned instructions"], ["plan", plan], ["role", JSON.stringify(roleConfiguration)] ] as const).map(([kind, content]) => { const path = join(root, kind); writeFileSync(path, content, { mode: 0o444 }); return { path, hash: hashBytes(content), kind, readOnly: true as const, ...(kind === "framework" ? { source } : {}) }; });
  chmodSync(root, 0o555);
  const input: ContextInput = { runId: "run", assignment: { taskId: "T007", role: "implementer", paths: ["src"], dependencies: [] }, outputs: ["src/result.ts"], permissions: ["write-assigned-tree"], role: "implementer", client: "claude-code", binding, root, mutableStateRoot: join(base, "state"), frameworkRoot: join(base, "framework"), frameworkRevision: FRAMEWORK_PIN.revision, workerUid: process.getuid!() + 100000, workerGroups: [], discoveryRoots: [root], files };
  const observed = { discoveryRoots: [root], files: files.map(({ path, hash }) => ({ path, hash })) }; return { base, input, observed };
}
it.each(["claude-code", "codex"] as const)("%s binds generated and observed hashes and freezes projected authority", client => { const { input, observed } = fixture(); input.client = client; const m = createContextManifest(input); expect(verifyEffectiveContext(m, observed)).toBe(hashBytes(canonicalJson(observed))); expect(Object.isFrozen(m.files[0])).toBe(true); expect(Object.isFrozen(m.binding.writePaths)).toBe(true); expect(readFileSync(m.files[0]!.path, "utf8")).toBe("pinned instructions"); });
it.each(["parent", "global", "unobserved"])("rejects %s instruction contamination", kind => { const { input, observed } = fixture(), m = createContextManifest(input); if (kind === "unobserved") observed.files.pop(); else observed.files.push({ path: kind === "parent" ? join(input.root, "..", "AGENTS.md") : "/global/CLAUDE.md", hash: hashBytes("extra") }); expect(() => verifyEffectiveContext(m, observed)).toThrow(); });
it.each(["file", "parent", "owner", "state", "pin", "source", "alias", "role", "unreadable", "unsearchable"])("rejects invalid projected context: %s", kind => { const { base, input } = fixture(); if (kind === "unreadable") chmodSync(input.files[0]!.path, 0o400); if (kind === "unsearchable") chmodSync(base, 0o700); if (kind === "file") chmodSync(input.files[0]!.path, 0o666); if (kind === "parent") chmodSync(input.root, 0o777); if (kind === "owner") input.workerUid = process.getuid!(); if (kind === "state") input.mutableStateRoot = input.root; if (kind === "pin") input.frameworkRevision = "wrong"; if (kind === "source") { const d = join(input.frameworkRoot, ".agents"); mkdirSync(d); const p = join(d, "skill.md"); writeFileSync(p, "pinned instructions"); input.files[0]!.source = p; } if (kind === "alias") { const p = join(base, "alias"); symlinkSync(input.root, p); input.root = p; } if (kind === "role") input.client = "unsupported" as "codex"; expect(() => createContextManifest(input)).toThrow(); });
it("blocks changed projected bytes on resume", () => { const { input, observed } = fixture(), m = createContextManifest(input); chmodSync(input.files[0]!.path, 0o644); writeFileSync(input.files[0]!.path, "changed"); expect(() => verifyEffectiveContext(m, observed)).toThrow(); });
function leadFixture() {
  const f = fixture(); f.input.role = "lead"; f.input.assignment.role = "lead"; f.input.outputs = []; f.input.permissions = ["request-assignment"]; f.input.client = "codex";
  f.input.lead = { activationId: "activation-1", roster: [{ member: "backend", role: "implementer", mailbox: "run/backend" }], instructions: "Current run instructions" };
  chmodSync(f.input.root, 0o755);
  for (const [kind, content] of [["protocol", leadProtocol], ["roster", JSON.stringify(f.input.lead.roster)], ["run", f.input.lead.instructions]] as const) {
    const path = join(f.input.root, kind); writeFileSync(path, content, { mode: 0o444 }); f.input.files.push({ path, hash: hashBytes(content), kind, readOnly: true });
  }
  chmodSync(f.input.root, 0o555); return f;
}
it("includes current read-only Lead protocol, roster and instructions on every activation", () => {
  const { input } = leadFixture(), first = createContextManifest(input);
  expect(first.protocolVersion).toBe("1"); expect(first.files.every(f => f.readOnly)).toBe(true);
  input.lead!.activationId = "activation-2"; input.lead!.roster[0]!.mailbox = "run/reassigned";
  const roster = input.files.find(f => f.kind === "roster")!, content = JSON.stringify(input.lead!.roster);
  chmodSync(roster.path, 0o644); writeFileSync(roster.path, content); chmodSync(roster.path, 0o444); roster.hash = hashBytes(content);
  const second = createContextManifest(input); expect(second.generatedHash).not.toBe(first.generatedHash); expect(second.lead!.roster[0]!.mailbox).toBe("run/reassigned"); expect(first.lead!.roster[0]!.mailbox).toBe("run/backend");
});
it.each(["missing", "protocol", "roster", "instructions", "role"])("blocks incomplete or stale Lead activation context: %s", kind => {
  const { input } = leadFixture(); if (kind === "missing") input.files = input.files.filter(f => f.kind !== "protocol");
  else if (kind === "role") { input.lead!.roster[0]!.role = "toString" as "implementer"; const f = input.files.find(f => f.kind === "roster")!, content = JSON.stringify(input.lead!.roster); chmodSync(f.path, 0o644); writeFileSync(f.path, content); chmodSync(f.path, 0o444); f.hash = hashBytes(content); }
  else if (kind === "roster") input.lead!.roster[0]!.mailbox = "stale";
  else if (kind === "instructions") input.lead!.instructions = "stale";
  else { const p = input.files.find(f => f.kind === "protocol")!; chmodSync(p.path, 0o644); writeFileSync(p.path, "Version: old"); chmodSync(p.path, 0o444); p.hash = hashBytes("Version: old"); }
  expect(() => createContextManifest(input)).toThrow();
});
it("prepares an assignment with the actual immutable manifest and observed context", async () => {
  const { input, observed } = fixture(), context = createContextManifest(input);
  const result = await prepareTeamAssignment({ binding: input.binding, currentBinding: input.binding, assignment: input.assignment, outputs: input.outputs, permissions: input.permissions, context, observed, dependencySatisfied: () => false });
  expect(result.context.generatedHash).toBe(context.generatedHash); expect(result.observedHash).toBe(hashBytes(canonicalJson(observed)));
});
