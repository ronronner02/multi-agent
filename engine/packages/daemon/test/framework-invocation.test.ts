import { describe, expect, it, vi } from "vitest";
import type { PlanBinding } from "../src/contracts/team-control.js";
import { FRAMEWORK_PIN } from "../src/integrations/framework/catalog.js";
import { invokeFramework, type FrameworkRequest } from "../src/integrations/framework/invocation.js";

function fixture(client: FrameworkRequest["client"] = "claude-code") {
  const binding: PlanBinding = {
    artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
    planRef: "docs/plan.md", planDigest: "sha256:" + "a".repeat(64),
    repository: { root: "/workspace/project", identity: "git:" + "b".repeat(40) },
    readPaths: ["docs"], writePaths: ["src"], roles: ["implementer", "reviewer"],
    policyRevision: 1, policyFingerprint: "sha256:" + "c".repeat(64),
    limits: { maxSessions: 3, maxActiveMs: 60000, maxRetries: 1, maxReviewRounds: 2 },
  };
  const request: FrameworkRequest = { client, entrypoint: "spec-work", origin: "caller", binding, input: "Implement the assigned slice", readOnly: false };
  const bridge = {
    checkReadiness: vi.fn(async () => ({ ready: true, reason: "" })),
    invoke: vi.fn(async (_request: unknown): Promise<unknown> => ({ status: "complete", artifacts: ["evidence/result.md"] })),
  };
  return { request, bridge };
}

describe("bounded framework invocation", () => {
  it.each(["claude-code", "codex"] as const)("%s preserves the approved scope and uses the pinned native entrypoint", async client => {
    const { request, bridge } = fixture(client);
    expect(await invokeFramework(request, bridge)).toEqual({ status: "complete", artifacts: ["evidence/result.md"], reason: "" });
    const prepared = bridge.invoke.mock.calls[0]![0] as FrameworkRequest & { revision: string; nativeInvocation: string };
    expect(prepared).toMatchObject({ binding: request.binding, revision: FRAMEWORK_PIN.revision, nativeInvocation: `${client === "codex" ? "$" : "/"}spec-work` });
    expect(bridge.checkReadiness).toHaveBeenCalledOnce();
  });
  it.each(["claude-code", "codex"] as const)("%s code review stays report-only even when writes are requested", async client => {
    const { request, bridge } = fixture(client);
    request.entrypoint = "spec-code-review";
    await invokeFramework(request, bridge);
    const prepared = bridge.invoke.mock.calls[0]![0] as FrameworkRequest & { nativeInvocation: string };
    expect(prepared).toMatchObject({ readOnly: true, binding: { readPaths: ["docs", "src"], writePaths: [] } });
    expect(prepared.nativeInvocation).toContain("spec-code-review mode:agent");
    expect(request.binding.writePaths).toEqual(["src"]);
  });
  it.each([
    { entrypoint: "review" }, { client: "other" }, { origin: "unknown" }, { readOnly: "false" },
    { binding: { status: "completed" } },
  ])("rejects malformed or unsupported invocation input before dispatch: %j", async change => {
    const { request, bridge } = fixture();
    expect((await invokeFramework({ ...request, ...change } as FrameworkRequest, bridge)).status).toBe("blocked");
    expect(bridge.invoke).not.toHaveBeenCalled();
  });
  it.each(["spec-test-xcode", "spec-handoff", "spec-lfg", "spec-prototype"])("keeps %s behind its original invocation gate", async entrypoint => {
    const { request, bridge } = fixture();
    expect((await invokeFramework({ ...request, entrypoint }, bridge)).status).toBe("blocked");
    expect(bridge.checkReadiness).not.toHaveBeenCalled();
    expect(bridge.invoke).not.toHaveBeenCalled();
  });
  it("keeps internal delivery helpers caller-owned and delegates their grants to upstream", async () => {
    const { request, bridge } = fixture();
    request.entrypoint = "spec-commit-push-pr";
    expect((await invokeFramework({ ...request, origin: "user" }, bridge)).status).toBe("blocked");
    bridge.checkReadiness.mockResolvedValue({ ready: false, reason: "landing_authorization_missing" });
    expect(await invokeFramework(request, bridge)).toMatchObject({ status: "blocked", reason: "landing_authorization_missing" });
    expect(bridge.invoke).not.toHaveBeenCalled();
  });
  it("accepts an explicit user invocation only after upstream readiness succeeds", async () => {
    const { request, bridge } = fixture();
    expect((await invokeFramework({ ...request, entrypoint: "spec-handoff", origin: "user" }, bridge)).status).toBe("complete");
    expect(bridge.checkReadiness).toHaveBeenCalledOnce();
  });
  it("preserves upstream stale-plan refusal without starting a client", async () => {
    const { request, bridge } = fixture();
    bridge.checkReadiness.mockResolvedValue({ ready: false, reason: "source-plan-hash-drift" });
    expect(await invokeFramework(request, bridge)).toMatchObject({ status: "blocked", reason: "source-plan-hash-drift" });
    expect(bridge.invoke).not.toHaveBeenCalled();
  });
  describe.each(["claude-code", "codex"] as const)("%s artifact references", client => {
    it.each([
      "/outside.md", "C:/outside.md", String.raw`C:\outside.md`, String.raw`\\host\share\outside.md`,
      "../outside.md", "evidence/../../outside.md", "./result.md", "evidence//result.md", "~/result.md", "evidence/\u0000report.md",
    ])("keeps a malformed artifact %j incomplete", async artifact => {
      const { request, bridge } = fixture(client);
      bridge.invoke.mockResolvedValue({ status: "complete", artifacts: ["evidence/result.md", artifact] });
      expect(await invokeFramework(request, bridge))
        .toEqual({ status: "incomplete", artifacts: [], reason: "malformed-framework-outcome" });
    });
  });
  it.each([null, "done", {}, { status: "approved", artifacts: [] }, { status: "complete", artifacts: [] },
    { status: "complete", artifacts: [""] }, { status: "complete", artifacts: "result" }, { status: "blocked", artifacts: [] },
  ])("keeps malformed or unevidenced output incomplete: %j", async outcome => {
    const { request, bridge } = fixture();
    bridge.invoke.mockResolvedValue(outcome);
    expect(await invokeFramework(request, bridge)).toMatchObject({ status: "incomplete", reason: "malformed-framework-outcome" });
  });
  it.each(["blocked", "failed", "incomplete"])("preserves an upstream %s result without inventing acceptance", async status => {
    const { request, bridge } = fixture();
    bridge.invoke.mockResolvedValue({ status, artifacts: [], reason: "upstream-reason", grants: ["commit"] });
    expect(await invokeFramework(request, bridge)).toEqual({ status, artifacts: [], reason: "upstream-reason" });
  });
  it("snapshots and freezes the validated scope before readiness or native invocation", async () => {
    const { request, bridge } = fixture();
    bridge.checkReadiness.mockImplementation(async (...args: unknown[]) => {
      const prepared = args[0] as FrameworkRequest;
      request.binding.writePaths.push("unapproved");
      expect(Object.isFrozen(prepared.binding.writePaths)).toBe(true);
      return { ready: true, reason: "" };
    });
    await invokeFramework(request, bridge);
    expect((bridge.invoke.mock.calls[0]![0] as FrameworkRequest).binding.writePaths).toEqual(["src"]);
  });
  it("propagates a native transport failure instead of reporting completion", async () => {
    const { request, bridge } = fixture();
    bridge.invoke.mockRejectedValue(new Error("native transport stopped"));
    await expect(invokeFramework(request, bridge)).rejects.toThrow("native transport stopped");
  });
});
