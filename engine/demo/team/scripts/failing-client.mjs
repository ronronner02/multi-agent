/**
 * A client that comes up, prints what a provider failure looks like, and exits.
 *
 * The failure demo needs an attempt that really ends with a failure the daemon can read, because
 * the classifier's decision is only worth anything if the evidence behind it is real. This
 * client is a stand-in for a native client in the one way the launch path and the classifier
 * observe: it stays the pane's foreground process after launch, it prints its failure to the
 * pane's own output, and it exits with a status. Nothing in the daemon is told what happened.
 *
 * The text it prints is Anthropic's documented 401 body, behind the `API Error:` prefix Claude
 * Code prints it with. That is the same evidence `test/fixtures/attempt-failure/client-errors.json`
 * records a source for; this client reproduces it rather than inventing a different failure.
 *
 * Usage: node failing-client.mjs --session-name <seat> --cwd <tree> --launch-id <id> [--failure <kind>]
 *   kind=auth      prints the 401 and exits 1 (not retryable: the account needs repair)
 *   kind=network   prints a refused connection and exits 1 (retryable: KTD20's provider_network)
 */

const argv = process.argv.slice(2);
const flag = name => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
const seat = flag("--session-name") ?? "seat";
const failure = flag("--failure") ?? "auth";

console.log(`[failing-client] ${seat} up`);

// Come up as the pane's foreground process first, exactly as a client that reached readiness
// does: the launch path refuses a client that never becomes the pane's process, and the
// orchestrator's own readiness check runs after the launch. Only then does this attempt fail.
await new Promise(resolve => setTimeout(resolve, 2_000));

if (failure === "network") {
  // A connection the provider never accepted: KTD20's only retryable client code.
  console.error("API Error: Unable to connect to API (ECONNREFUSED)");
  process.exit(1);
}

// Anthropic's documented 401 body, as Claude Code prints it.
console.error('API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}');
process.exit(1);
