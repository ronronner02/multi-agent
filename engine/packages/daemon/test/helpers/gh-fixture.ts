// U9: Test helper for Windows Node-launcher fixtures
// Tests on Windows pass `process.execPath` + script path because `.mjs` is not a launchable
// executable. This is the same shape every test uses via a shared wrapper.
import { isAbsolute, join } from "node:path";

export function ghFixturePath(directory: string): { executable: string; extraArgs: string[] } {
  if (process.platform !== "win32") {
    return { executable: join(directory, "gh"), extraArgs: [] };
  }
  // On Windows, the resolver refuses .mjs as a launch target. The stub is invoked through
  // process.execPath so it runs like any Node test helper would.
  return { executable: process.execPath, extraArgs: [join(directory, "gh.mjs")] };
}
