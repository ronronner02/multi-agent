import { parsePlanBinding, relativePath, type PlanBinding } from "../../contracts/team-control.js";
import { FRAMEWORK_PIN, frameworkEntry, type FrameworkEntry } from "./catalog.js";

export interface FrameworkRequest {
  client: "claude-code" | "codex";
  entrypoint: string;
  origin: "user" | "caller";
  binding: PlanBinding;
  input: string;
  readOnly: boolean;
}
export type PreparedFrameworkInvocation = Readonly<FrameworkRequest & { revision: string; nativeInvocation: string }>;
export interface FrameworkOutcome {
  status: "complete" | "incomplete" | "blocked" | "failed";
  artifacts: string[];
  reason: string;
}
export interface FrameworkBridge {
  checkReadiness(request: PreparedFrameworkInvocation, entry: FrameworkEntry): Promise<{ ready: boolean; reason?: string }>;
  // The bridge translates upstream output into this evidence envelope; workflow meaning stays upstream.
  invoke(request: PreparedFrameworkInvocation): Promise<unknown>;
}

export async function invokeFramework(request: FrameworkRequest, bridge: FrameworkBridge): Promise<FrameworkOutcome> {
  const blocked = (reason: string): FrameworkOutcome => ({ status: "blocked", artifacts: [], reason });
  const entry = frameworkEntry(request.entrypoint);
  if (!entry) return blocked("unknown-framework-entrypoint");
  if (!["claude-code", "codex"].includes(request.client) || !["user", "caller"].includes(request.origin)
      || typeof request.input !== "string" || typeof request.readOnly !== "boolean") return blocked("invalid-framework-request");
  if (entry.status === "deferred") return blocked(entry.prerequisite);
  if (entry.invocation !== "workflow" && entry.invocation !== request.origin) return blocked(`${entry.invocation}-invocation-required`);
  let binding: PlanBinding;
  try { binding = parsePlanBinding(request.binding); }
  catch { return blocked("invalid-framework-binding"); }
  const review = entry.name === "spec-code-review";
  const readOnly = request.readOnly || review;
  if (readOnly) {
    binding.readPaths = [...new Set([...binding.readPaths, ...binding.writePaths])];
    binding.writePaths = [];
  }
  for (const value of Object.values(binding)) {
    if (value !== null && typeof value === "object") Object.freeze(value);
  }
  Object.freeze(binding);
  const prepared: PreparedFrameworkInvocation = Object.freeze({
    client: request.client, entrypoint: entry.name, origin: request.origin,
    binding, input: request.input, readOnly, revision: FRAMEWORK_PIN.revision,
    nativeInvocation: `${request.client === "codex" ? "$" : "/"}${entry.name}${review ? " mode:agent" : ""}`,
  });
  // Catalog availability never substitutes for the upstream owner's readiness or grant checks.
  const readiness = await bridge.checkReadiness(prepared, entry);
  if (readiness?.ready !== true) return blocked(typeof readiness?.reason === "string" && readiness.reason.trim()
    ? readiness.reason : entry.status === "gated" ? entry.prerequisite : "framework-not-ready");
  const output = await bridge.invoke(prepared);
  const incomplete: FrameworkOutcome = { status: "incomplete", artifacts: [], reason: "malformed-framework-outcome" };
  if (output === null || typeof output !== "object") return incomplete;
  const { status, artifacts, reason = "" } = output as Record<string, unknown>;
  if (typeof status !== "string" || !["complete", "incomplete", "blocked", "failed"].includes(status)
      || !Array.isArray(artifacts) || !Array.from(artifacts).every(path => typeof path === "string" && path.trim())
      || typeof reason !== "string" || (status === "complete" ? !artifacts.length : !reason.trim())) return incomplete;
  try { for (const path of artifacts) relativePath(path, "frameworkOutcome.artifacts"); }
  catch { return incomplete; }
  return { status: status as FrameworkOutcome["status"], artifacts: [...artifacts], reason };
}
