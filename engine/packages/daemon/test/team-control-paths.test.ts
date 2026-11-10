import { describe, expect, it } from "vitest";
import { absolutePath, parsePlanBinding, relativePath } from "../src/contracts/team-control.js";

/**
 * R15 — the team boundary accepts native Windows paths and keeps protocol paths relative.
 *
 * The shapes are decided by the value's own spelling, not by the host running the parse, so this
 * matrix is the same on both operating systems: a Windows binding stored by a Windows daemon
 * still parses on a POSIX one, and the reverse.
 */

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const binding = {
  artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
  planRef: "docs/plan.md", planDigest: digest("a"), repository: { root: "/workspace/project", identity: `git:${"b".repeat(40)}` },
  readPaths: ["src"], writePaths: ["src"], roles: ["lead", "implementer", "reviewer"],
  policyRevision: 1, policyFingerprint: digest("c"),
  limits: { maxSessions: 3, maxActiveMs: 3_600_000, maxRetries: 1, maxReviewRounds: 2 },
};

describe("absolute roots at the team boundary", () => {
  it.each([
    ["POSIX root", "/workspace/project"],
    ["drive with backslashes", "C:\\Users\\owner\\project"],
    ["drive with forward slashes", "C:/Users/owner/project"],
    ["lower-case drive", "d:\\ma\\u7"],
    ["UNC share path", "\\\\server\\share\\project"],
    ["UNC path with forward slashes", "//server/share/project"],
    ["UNC share root with a project under it", "\\\\server\\share\\a b"],
    ["extended-length drive path", "\\\\?\\C:\\long\\project"],
    ["path with a space", "C:\\Users\\owner\\my project"],
  ])("accepts a %s", (_kind, value) => {
    expect(absolutePath(value, "repository.root")).toBe(value);
    expect(parsePlanBinding({ ...binding, repository: { ...binding.repository, root: value } }).repository.root).toBe(value);
  });

  it.each([
    ["a filesystem root", "/"],
    ["a drive root", "C:\\"],
    ["a drive root with a forward slash", "C:/"],
    ["a bare drive", "C:"],
    ["a drive-relative path", "C:project"],
    ["a root-relative path", "\\project"],
    ["a UNC share root", "\\\\server\\share"],
    ["a UNC server with no share", "\\\\server"],
    ["a POSIX double slash", "//x"],
    ["a relative path", "project/src"],
    ["a dot segment", "/workspace/./project"],
    ["a parent segment", "C:\\Users\\..\\project"],
    ["an empty segment", "/workspace//project"],
    ["a trailing separator", "C:\\Users\\owner\\"],
    ["a trailing POSIX separator", "/workspace/"],
    ["a tilde path", "~/project"],
  ])("refuses %s", (_kind, value) => {
    expect(() => absolutePath(value, "repository.root")).toThrow();
    expect(() => parsePlanBinding({ ...binding, repository: { ...binding.repository, root: value } })).toThrow();
  });
});

describe("relative paths inside the protocol", () => {
  it.each(["src", "src/api/health.ts", ".github/workflows/ci.yml", "docs/plan.md"])("accepts %s with forward slashes", (value) => {
    expect(relativePath(value, "path")).toBe(value);
  });

  it.each([
    ["a backslash", "src\\api"],
    ["a drive letter", "C:src"],
    ["an absolute POSIX path", "/src"],
    ["a Windows absolute path", "C:\\src"],
    ["a home path", "~/src"],
    ["a parent segment", "src/../server"],
    ["a dot segment", "./src"],
    ["an empty segment", "src//api"],
    ["a wildcard", "src/**"],
    ["a trailing slash", "src/"],
  ])("refuses %s so one scope has one spelling", (_kind, value) => {
    expect(() => relativePath(value, "path")).toThrow();
  });
});
