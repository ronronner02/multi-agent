// OPR.0.4.4.23 — the scaffold emits the SDLC convention sections for EVERY
// SliceTemplateKind (the Rev-2 exhaustive contract): a slice that doesn't
// carry `## Intent` / `## Mini-requirements` / `## Proof contract` doesn't
// expose the one scope convention, whatever its template kind. The tests
// ENUMERATE the exported kind set, so a future kind added to
// SLICE_TEMPLATE_KINDS fails here until its template carries the sections.
// Conventions SSOT: docs/reference/sdlc-conventions.md.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import {
  renderCapabilityDeltaTemplate,
  renderNotesTemplate,
  renderSliceProofTemplate,
  renderSliceTemplate,
} from "../src/lib/scope/templates.js";
import { MISSION_TEMPLATE_KINDS, SLICE_TEMPLATE_KINDS } from "../src/lib/scope/types.js";
import { renderMissionTemplate } from "../src/lib/scope/templates.js";

function readTemplateFrontmatter(file: string): Record<string, unknown> {
  const text = fs.readFileSync(file, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return match ? parseYaml(match[1]!) ?? {} : {};
}

const CONVENTION_SECTIONS = ["## Intent", "## Mini-requirements", "## Proof contract"] as const;
const SSOT_POINTER = "docs/reference/sdlc-conventions.md";

// aa922842 — the dual-context pointer contract.
//
// Scaffolded output lands in a USER's workspace, so it is installed-facing: the reader may
// have no repo at all. The same doc reaches them by three different paths and only two may
// ever be taught:
//   repo source      docs/reference/sdlc-conventions.md          — correct for repo readers
//   installed stable $OPENRIG_HOME/reference/sdlc-conventions.md — correct for installed agents
//                                                                  (default ~/.openrig/…)
//   packed internal  daemon/docs/reference/…                     — assembly input, NEVER taught
//
// Two failure modes this guards, both of which look fine in a repo checkout:
//   1. teaching ONLY the repo path — an installed agent looks somewhere that does not exist;
//   2. teaching the DEFAULT home as the only path — wrong for any operator with a custom
//      OPENRIG_HOME (this rig runs one). Naming `$OPENRIG_HOME/...` is MANDATORY; mentioning
//      `~/.openrig/...` alongside it as the default is honest and explicitly allowed, so this
//      does NOT ban the default — requiring the env-aware pointer already covers the risk.
const INSTALLED_POINTER_ENV = "$OPENRIG_HOME/reference/sdlc-conventions.md";
const INTERNAL_PACKED_PATH = "daemon/docs/reference/";

const RENDER_OPTS = {
  id: "OPR.0.4.4.99",
  slice_number: "99",
  slug: "conventions-probe",
  mission: "release-0.4.4",
  title: "Conventions Probe",
  created_date: "2026-07-06",
};

function mktemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rig-scope-conventions-"));
}

describe("OPR.0.4.4.23 convention scaffold — exhaustive over SliceTemplateKind", () => {
  it("every SliceTemplateKind template emits the three convention sections + the SSOT pointer", () => {
    for (const kind of SLICE_TEMPLATE_KINDS) {
      const rendered = renderSliceTemplate(kind, RENDER_OPTS);
      const specPath = path.join(mktemp(), "SPEC.md");
      fs.writeFileSync(specPath, rendered, "utf8");
      const frontmatter = readTemplateFrontmatter(specPath);
      fs.rmSync(path.dirname(specPath), { recursive: true, force: true });
      expect(frontmatter.intent, `template kind "${kind}" has no frontmatter intent`).toBe(RENDER_OPTS.title);
      expect(frontmatter.depends_on, `template kind "${kind}" has no sibling-ordering edge list`).toEqual([]);
      for (const section of CONVENTION_SECTIONS) {
        expect(rendered, `template kind "${kind}" is missing "${section}"`).toContain(section);
      }
      expect(rendered, `template kind "${kind}" is missing the SSOT pointer`).toContain(SSOT_POINTER);
      expect(rendered, `template kind "${kind}" is missing the mission-slice-sop skill pointer`).toContain("mission-slice-sop");
    }
  });

  // aa922842 — dual-context pointer discriminator. Scaffolded output is installed-facing.
  it("every slice template teaches BOTH contexts: the repo path AND the OPENRIG_HOME-aware installed path", () => {
    for (const kind of SLICE_TEMPLATE_KINDS) {
      const rendered = renderSliceTemplate(kind, RENDER_OPTS);
      // Repo context retained — a repo reader must not be sent to an installed-only path.
      expect(rendered, `template kind "${kind}" dropped the repo-source pointer`).toContain(SSOT_POINTER);
      // Installed context added — without this an agent on an installed package is told to
      // read a path that does not exist on their machine.
      expect(
        rendered,
        `template kind "${kind}" never names the installed stable path; an installed agent cannot find the conventions doc from this scaffold`,
      ).toContain(INSTALLED_POINTER_ENV);
    }
  });

  it("no template leaks the internal packed path as if it were a user path", () => {
    for (const kind of SLICE_TEMPLATE_KINDS) {
      const rendered = renderSliceTemplate(kind, RENDER_OPTS);
      expect(
        rendered.includes(INTERNAL_PACKED_PATH),
        `template kind "${kind}" teaches the internal assembly path ${INTERNAL_PACKED_PATH} as if it were a user path`,
      ).toBe(false);
    }
  });

  it("the convention sections come FIRST — kind-specific body sits below them", () => {
    for (const kind of SLICE_TEMPLATE_KINDS) {
      const rendered = renderSliceTemplate(kind, RENDER_OPTS);
      const firstSectionIdx = rendered.indexOf("## ");
      expect(
        rendered.slice(firstSectionIdx).startsWith("## Intent"),
        `template kind "${kind}" does not open its sections with ## Intent`,
      ).toBe(true);
      const miniIdx = rendered.indexOf("## Mini-requirements");
      const proofIdx = rendered.indexOf("## Proof contract");
      expect(firstSectionIdx, `kind "${kind}" section order broken`).toBeLessThan(miniIdx);
      expect(miniIdx, `kind "${kind}" section order broken`).toBeLessThan(proofIdx);
    }
  });

  it("mission templates carry intent + depends_on frontmatter and the convention pointers", () => {
    for (const kind of MISSION_TEMPLATE_KINDS) {
      const rendered = renderMissionTemplate(kind, RENDER_OPTS);
      const specPath = path.join(mktemp(), "SPEC.md");
      fs.writeFileSync(specPath, rendered, "utf8");
      const frontmatter = readTemplateFrontmatter(specPath);
      fs.rmSync(path.dirname(specPath), { recursive: true, force: true });
      expect(frontmatter.intent, `mission template "${kind}" has no frontmatter intent`).toBe(RENDER_OPTS.title);
      expect(frontmatter.depends_on, `mission template "${kind}" has no sibling-ordering edge list`).toEqual([]);
      expect(rendered, `mission template "${kind}" is missing the SSOT pointer`).toContain(SSOT_POINTER);
      expect(rendered, `mission template "${kind}" is missing the mission-slice-sop pointer`).toContain("mission-slice-sop");
    }
  });
});

describe("release capability-delta scaffold and expiry advisory", () => {
  const releaseOpts = {
    ...RENDER_OPTS,
    slug: "release-0.5.4",
    mission: "release-0.5.4",
    title: "0.5.4",
    release_version: "0.5.4",
  };

  it("renders the reviewed delta shape from the shipped template", () => {
    const rendered = renderCapabilityDeltaTemplate(releaseOpts);
    for (const required of [
      "capability_delta: capability-delta-v0.5.4",
      "binding_target:",
      "sha:",
      "dirty:",
      "audience:",
      "review_status:",
      "expiry:",
      "## What you can now do (situation-keyed)",
      "REACH FOR IT WHEN",
      "## Landed, not yet drivable",
      "## What to STOP doing",
      "Correct before:",
      "Wrong now:",
      "## Selection probes",
      "DELTA-ONLY QUALIFICATION",
      "## Canon patch",
      "Already present — do not duplicate",
      SSOT_POINTER,
      INSTALLED_POINTER_ENV,
    ]) {
      expect(rendered, `capability-delta template is missing ${required}`).toContain(required);
    }
  });
});

// OPR.0.4.4.23 PM-acceptance fixback — the shipped teaching surfaces must
// LEAD a naive agent to the C1 drop verb: every scaffolded artifact that
// mentions proving names `rig proof add` and `--media` explicitly (the
// naive-agent rerun showed generic "rig proof drops" prose produced manual
// proof-dir curation and no C1 drops).
describe("OPR.0.4.4.23 teaching surfaces name the drop verb", () => {
  it("every slice template's proving guidance names rig proof add and --media", () => {
    for (const kind of SLICE_TEMPLATE_KINDS) {
      const rendered = renderSliceTemplate(kind, RENDER_OPTS);
      expect(rendered, `template kind "${kind}" does not name rig proof add`).toContain("rig proof add");
      expect(rendered, `template kind "${kind}" does not name --media`).toContain("--media");
    }
  });

  it("the PROOF.md template names rig proof add and --media and binds to SPEC.md", () => {
    const proof = renderSliceProofTemplate({ id: RENDER_OPTS.id, title: RENDER_OPTS.title });
    expect(proof).toContain("rig proof add");
    expect(proof).toContain("--media");
    expect(proof).toContain("SPEC.md");
    expect(proof).toContain("Hand-placing files without a drop");
  });
});

it("retains unknown custom notes tokens and does not interpolate tokens in the authored name", () => {
  const root = mktemp();
  try {
    const template = path.join(root, "custom-notes.md");
    fs.writeFileSync(template, "{{mission_name}}\n{{mission_name_yaml}}\n{{created_date}}\n{{unknown}} {{constructor}} {{__proto__}}\n");
    const name = "$$ $& {{created_date}}";
    const result = renderNotesTemplate({ mission_id: "OPR.9.9.9", mission_name: name, created_date: "2026-10-07" }, template);
    expect(result.resolvedFrom).toBe("env");
    expect(result.rendered).toBe(`${name}\n${JSON.stringify(name)}\n2026-10-07\n{{unknown}} {{constructor}} {{__proto__}}\n`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
