import { describe, it, expect, vi } from "vitest";
import { formatBundleBehaviour, showBundleBehaviourBeforeAction } from "../src/bundle-behaviour.js";
import fs from "node:fs";

const view = {
  schema: "openrig.bundle-behaviour/v1" as const,
  state: "not_generated" as const,
  identity: { source: null, configurationId: null, packageDigest: null, assembler: null, generator: { openrigVersion: "0.6.6" }, integrity: { digestValid: true, filesVerified: true } },
  reason: "Not generated for this combination.", localInspectCommand: "rig bundle inspect <archive> --json",
};

type GeneratedView = Extract<Parameters<typeof formatBundleBehaviour>[0], { state: "generated" }>;
function generatedView(name = "mixed-runtimes-default"): GeneratedView {
  return JSON.parse(fs.readFileSync(new URL(
    `../../../docs/reference/schemas/fixtures/valid/behaviour/${name}.json`, import.meta.url,
  ), "utf8"));
}

describe("before-action bundle view", () => {
  it("prints before the caller's action without writing stdout or a new exit code", async () => {
    const events: string[] = [];
    const before = process.exitCode;
    const inspect = vi.fn(async () => ({ status: 200, data: { behaviour: view } }));
    expect(await showBundleBehaviourBeforeAction(inspect, line => events.push(line))).toEqual(view);
    events.push("apply");
    expect(events.indexOf("apply")).toBe(events.length - 1);
    expect(events[0]).toContain("before installation");
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(before);
  });
  it.each([async () => { throw new Error("unavailable"); }, async () => ({ status: 500, data: { error: "unavailable" } })])("keeps view failure diagnostic", async (inspect) => {
    const output = vi.fn();
    const before = process.exitCode;
    expect(await showBundleBehaviourBeforeAction(inspect, output)).toBeUndefined();
    expect(output).toHaveBeenCalledWith(expect.stringContaining("Existing installation checks still apply"));
    expect(process.exitCode).toBe(before);
  });
  it("keeps required honest negations and neutralizes terminal controls", () => {
    const lines = formatBundleBehaviour({ ...view, reason: "unknown\u001b[2J\nvalue" });
    expect(lines.join("\n")).toContain("Integrity means the archive is self-consistent, not who made it.");
    expect(lines.join("\n")).toContain("Provenance is stated by the bundle and not verified.");
    expect(lines.some(line => /[\x00-\x1f]/.test(line))).toBe(false);
    expect(lines.join(" ")).not.toMatch(/verified safe|trusted bundle|secure bundle/i);
  });

  it("renders declared setup commands in their original order without running them", () => {
    const generated = generatedView();
    generated.needs = [{ kind: "precondition", name: "Prepare the source clone",
      commands: ["cd openrig", "npm ci", "npm run build"], status: "not_checked", sourceRefs: [] }];
    const rendered = formatBundleBehaviour(generated).join("\n");
    expect(rendered).toContain("Prepare the source clone");
    expect(rendered).toContain("Author setup commands (not run; one shell, in order):\n      cd openrig\n      npm ci\n      npm run build");
  });

  it("renders a large setup command list without losing the whole view to the argument limit", () => {
    const commands = Array.from({ length: 200_000 }, (_, index) => `echo ${index}`);
    const generated = generatedView();
    generated.needs = [{ kind: "precondition", name: "Author setup", commands,
      status: "not_checked", sourceRefs: [] }];
    const lines = formatBundleBehaviour(generated);
    const start = lines.indexOf("    Author setup commands (not run; one shell, in order):") + 1;
    expect(start).toBeGreaterThan(0);
    expect(lines.slice(start, start + commands.length)).toEqual(commands.map(command => `      ${command}`));
    expect(lines[start + commands.length]).toBe("Unknown before launch:");
  });

  it("labels repeated per-seat facts in inspect and previews while preserving global and older entries", async () => {
    const generated = generatedView();
    const seats = ["build.lead", "build.impl"];
    generated.needs = [
      ...seats.flatMap(seat => [
        { seat, kind: "runtime", name: "codex", status: "not_checked" as const, sourceRefs: [] },
        { seat, kind: "login", name: "codex: the user's own runtime account or provider configuration", status: "not_checked" as const, sourceRefs: [] },
      ]),
      { kind: "precondition", name: "Prepare the source clone", status: "not_checked", sourceRefs: [] },
      { kind: "tool", name: "Docker Compose and the declared services", status: "not_checked", sourceRefs: [] },
      { kind: "version", name: "OpenRig CLI", versionConstraint: ">=0.6.6", status: "not_checked", sourceRefs: [] },
    ];
    generated.alsoRuns = seats.map(seat => ({ seat, kind: "plugins", pathOrRef: "openrig-home:plugins/core", resolution: "host_at_launch", sourceRefs: [] }));
    generated.unknownBeforeLaunch = seats.flatMap(seat => [
      { seat, subject: "openrig-home:plugins/core", reason: "Resolved on the installing host", sourceRefs: [] },
      { seat, subject: seat, reason: "Prior conversation, starter and rebuild inputs are resolved at launch.", sourceRefs: [] },
    ]);
    const before = structuredClone(generated);
    const lines = formatBundleBehaviour(generated);
    for (const seat of seats) {
      expect(lines).toContain(`  ${seat}: codex`);
      expect(lines).toContain(`  ${seat}: codex: the user's own runtime account or provider configuration`);
      expect(lines.some(line => line.startsWith(`  ${seat}: plugins: openrig-home:plugins/core [`))).toBe(true);
      expect(lines.some(line => line.startsWith(`  ${seat}: openrig-home:plugins/core: Resolved on the installing host`))).toBe(true);
      expect(lines).toContain(`  ${seat}: Prior conversation, starter and rebuild inputs are resolved at launch.`);
      expect(lines.join("\n")).not.toContain(`${seat}: ${seat}:`);
    }
    expect(lines).toContain("  Prepare the source clone");
    expect(lines).toContain("  Docker Compose and the declared services");
    expect(lines).toContain("  OpenRig CLI >=0.6.6");
    const preview: string[] = [];
    expect(await showBundleBehaviourBeforeAction(async () => ({ status: 200, data: { behaviour: generated } }), line => preview.push(line))).toEqual(generated);
    expect(preview).toEqual(lines);
    expect(generated).toEqual(before);

    const older = structuredClone(generated);
    for (const item of [...older.needs, ...older.unknownBeforeLaunch, ...older.alsoRuns]) delete item.seat;
    const olderLines = formatBundleBehaviour(older);
    expect(olderLines).toContain("  codex");
    expect(olderLines.some(line => line.startsWith("  plugins: openrig-home:plugins/core ["))).toBe(true);
    expect(olderLines.some(line => line.startsWith("  openrig-home:plugins/core: Resolved on the installing host"))).toBe(true);
    expect(olderLines.join("\n")).not.toContain("undefined:");
  });

  it("renders declared yolo posture, warnings and optional mode without selecting it", () => {
    const actual = generatedView("mixed-runtimes-yolo");
    actual.posture[0]!.nonInterruptive = "available";
    actual.posture[1]!.nonInterruptive = "available";
    actual.posture[0]!.firstRunWarnings = { claudeBypass: "harness_asks_once" };
    const lines = formatBundleBehaviour(actual);
    expect(lines.join("\n")).toContain("does not select the mode or check whether you've already accepted the warning on this machine");
    expect(lines.join("\n")).toContain("when it has not been remembered");
    const start = lines.indexOf("Permission posture:");
    expect(start).toBeGreaterThan(0);
    expect(lines[start + 1]).toBe("Permission prompts: off for all seats (archive declaration).");
    ["Permission prompts: off; Claude bypasses permissions", "Permission prompts: off; Codex runs with full access and never asks", "Permission prompts: off; Pi gets full resource trust"].forEach((declaration, index) => expect(lines[start + index + 2]).toContain(declaration));
    expect(lines[start + 5]).toContain("subject to runtime and host policy");
    const older = structuredClone(actual);
    for (const item of older.posture) { delete item.nonInterruptive; delete item.firstRunWarnings; }
    expect(formatBundleBehaviour(older).join("\n")).not.toContain("Non-interruptive mode is available");
  });

  it("does not label a member override, a default or an unresolved policy as prompts off", () => {
    const actual = generatedView();
    expect(formatBundleBehaviour(actual).join("\n")).not.toContain("Permission prompts: off");
    const mixed = generatedView("mixed-runtimes-yolo");
    mixed.posture[0] = actual.posture[0]!;
    expect(formatBundleBehaviour(mixed)).not.toContain("Permission prompts: off for all seats (archive declaration).");
    actual.posture[0] = { ...actual.posture[0]!, basis: "unresolved", selection: "Policy unresolved" };
    delete actual.posture[0].permissionPrompts;
    expect(formatBundleBehaviour(actual).join("\n")).not.toContain("Permission prompts: off");
  });
});

it("shows authored non-interruptive broad access before action without asking for a flag", () => {
  const actual = generatedView("mixed-runtimes-yolo");
  actual.posture[0]!.nonInterruptiveDefault = true;
  const text = formatBundleBehaviour(actual).join("\n");
  expect(text).toContain("Non-interruptive launches are declared by this bundle");
  expect(text).toContain("broad file, command and network access");
  expect(text).toContain("--no-non-interruptive");
  expect(text).not.toContain("Claude Code asks for bypass-warning acceptance");
  expect(text).not.toContain("Non-interruptive mode is available using");
});
