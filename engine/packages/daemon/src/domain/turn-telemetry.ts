import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * U3 — the attempt's telemetry sidecars, for a turn the supervisor reads itself.
 *
 * The sidecars (`activity.jsonl`, `usage.json`, `progress.json`) used to be written by the pane's
 * readable view, which saw every provider record on its way to the screen. The supervisor sees the
 * same records on their way to the event log, so the same asset writes them from here.
 *
 * The asset is shipped as a plain `.mjs` next to the compiled daemon because the legacy pane path
 * still loads it as a script, so it is loaded dynamically and its failures are isolated: a missing
 * or broken asset disables the sidecars and changes nothing about the turn.
 */

export interface TurnTelemetry {
  /** One parsed provider record, in the order the client produced it. */
  observe(record: unknown): void;
  /** Publish the observed progress before notifying readers through the event stream. */
  flush(): void;
  /** The turn is over; publish the final snapshot. */
  finish(): void;
}

type TelemetryFactory = (resultFile: string, args: readonly string[], redact: (text: string) => string) => TurnTelemetry;

/** Where the shipped asset lives, resolved beside the compiled module on either path. */
export const TURN_TELEMETRY_ASSET = fileURLToPath(new URL("../../assets/agent-turn-telemetry.mjs", import.meta.url));

/**
 * Load the telemetry writer for one turn, or null when it cannot be loaded.
 *
 * A turn with no readable output file has nowhere to write its sidecars, and a host whose asset
 * is missing is one where telemetry is simply unavailable — neither is a reason to refuse the
 * turn, so both answer null.
 */
export async function loadTurnTelemetry(resultFile: string | undefined, args: readonly string[],
  redact: (text: string) => string): Promise<TurnTelemetry | null> {
  if (!resultFile) return null;
  try {
    const module = await import(pathToFileURL(TURN_TELEMETRY_ASSET).href) as { createTurnTelemetry?: TelemetryFactory };
    return module.createTurnTelemetry?.(resultFile, args, redact) ?? null;
  } catch { return null; }
}
