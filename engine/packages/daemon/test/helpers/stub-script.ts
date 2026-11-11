export const STUB_BEHAVIORS = ["compaction", "slow_output", "mid_turn_death", "restore"] as const;
export type StubBehavior = (typeof STUB_BEHAVIORS)[number];

export const REAL_RUNTIME_ONLY_BEHAVIORS = ["usage_limit"] as const;

export type StubStep =
  | { kind: "say"; text: string }
  | { kind: "emit"; behavior: StubBehavior };

export interface StubScript {
  steps: StubStep[];
}

export class StubScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StubScriptError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStep(raw: unknown, path: string): StubStep {
  if (!isPlainObject(raw)) throw new StubScriptError(`${path}: step must be an object`);
  if (raw.kind === "say") {
    if (typeof raw.text !== "string" || raw.text.length === 0) {
      throw new StubScriptError(`${path}.text: a say step requires a non-empty string`);
    }
    return { kind: "say", text: raw.text };
  }
  if (raw.kind === "emit") {
    if (typeof raw.behavior === "string" && (STUB_BEHAVIORS as readonly string[]).includes(raw.behavior)) {
      return { kind: "emit", behavior: raw.behavior as StubBehavior };
    }
    if (typeof raw.behavior === "string" && (REAL_RUNTIME_ONLY_BEHAVIORS as readonly string[]).includes(raw.behavior)) {
      throw new StubScriptError(`${path}.behavior: "${raw.behavior}" is real-runtime-only`);
    }
    throw new StubScriptError(`${path}.behavior: unknown behavior ${JSON.stringify(raw.behavior)}`);
  }
  throw new StubScriptError(`${path}.kind: unknown step kind ${JSON.stringify(raw.kind)}`);
}

export function parseStubScript(raw: string): StubScript {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StubScriptError("stub script is not valid JSON");
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.steps)) {
    throw new StubScriptError("stub script requires a steps array");
  }
  return { steps: parsed.steps.map((step, index) => parseStep(step, `steps[${index}]`)) };
}
