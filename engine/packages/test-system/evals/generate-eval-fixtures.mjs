#!/usr/bin/env node
/*
 * slice-07 R6 — seed fixture context-library generator.
 *
 * Writes minimal context packs at the canonical refs (skills/<ns>/<name>) the eval cases select among.
 * Derived output (regenerate; never hand-edit under fixtures/). Per Repair 2 the LIVE run does NOT
 * point a seat at these fixtures — it resolves refs against the EXACT production package built by
 * generate-context-packs.mjs. These fixtures back the structural canonical-ref checks only.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "fixtures");

// ref = library path (ns/name); the pack dir sits at fixtures/<ref>/, served at that ref.
const ENTRIES = [
  { ref: "skills/pods/orchestration-team", purpose: "coordinate a native team run", teaches: "Start a run with `multi-agent team start`, keep the owner decision in team chat, and approve it before work begins." },
  { ref: "skills/pods/development-team", purpose: "implement an assigned native team task", teaches: "Read the assigned goal and proof contract, make the smallest change, and report evidence through the team run." },
  { ref: "skills/pods/review-team", purpose: "review a native team result", teaches: "Read the task result and diff, verify acceptance conditions, and send a finding through team chat when evidence is missing." },
  { ref: "skills/process/context-engineering", purpose: "shape the context an agent needs", teaches: "Keep the smallest high-signal context set, retrieve details at the step that needs them, and write durable decisions to files." },
  { ref: "skills/process/systematic-debugging", purpose: "chase a failure methodically", teaches: "Instrument every boundary once and read where it actually breaks — one run beats five hypotheses." },
  { ref: "skills/process/verification-before-completion", purpose: "verify a result before claiming completion", teaches: "Run the check that proves the claim, read its complete output, and name any remaining limit." },
  // distractors — present so selection is a real choice, not a singleton
  { ref: "skills/pm/requirements-writer", purpose: "turn intent into requirements", teaches: "Proportional structured requirements — three capture points, elastic middle." },
  { ref: "skills/pm/plan-review", purpose: "review a proposed plan", teaches: "Check scope, sequencing, evidence, and the approval boundary before work starts." },
  { ref: "skills/pm/office-hours", purpose: "surface an unresolved product question", teaches: "Bring the owner the observed evidence, the remaining choices, and the consequence of each choice." },
  { ref: "skills/agent-operated-workflows", purpose: "follow a bounded repeatable workflow", teaches: "State inputs, outputs, permissions, and the check that proves the workflow completed." },
  { ref: "skills/process/test-driven-development", purpose: "red-first discipline", teaches: "A failing test per chunk; if you cannot show it red, it is not a check." },
];

rmSync(ROOT, { recursive: true, force: true });
for (const e of ENTRIES) {
  const dir = join(ROOT, e.ref);
  mkdirSync(dir, { recursive: true });
  const name = e.ref.split("/").pop();
  const manifest = `name: ${name}\nversion: "1"\ntaxonomy: skills\npurpose: "(eval fixture) ${e.purpose}"\nfiles:\n  - path: content.md\n    role: source\n`;
  writeFileSync(join(dir, "manifest.yaml"), manifest);
  writeFileSync(join(dir, "content.md"), `# ${e.ref}\n\n${e.purpose}\n\n${e.teaches}\n`);
}
console.log(`wrote ${ENTRIES.length} fixture packs under ${ROOT}`);
