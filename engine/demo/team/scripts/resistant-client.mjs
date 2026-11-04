/**
 * A client that refuses to leave when asked.
 *
 * The cancellation demo needs a process that survives SIGTERM, because that is the only way to
 * show the escalation the contract requires: SIGTERM, then SIGKILL after the grace period, and
 * `unresolved` if even that does not work. A real client can hang like this (a wedged tool call,
 * a blocked write), so the demo exercises the same path the daemon would take on one.
 *
 * It behaves like a launched client in the one way the launch path checks: it stays the pane's
 * foreground process until it is killed. SIGTERM is ignored on purpose; SIGINT and SIGHUP are
 * ignored too, so only SIGKILL ends it.
 *
 * Usage: node resistant-client.mjs --session-name <seat> --cwd <tree> --launch-id <id>
 */

const ignored = () => { /* Deliberately does nothing: this client does not leave on request. */ };
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, ignored);

const argv = process.argv.slice(2);
const flag = name => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
console.log(`[resistant] ${flag("--session-name") ?? "seat"} up; ignoring SIGTERM`);
// Hold the event loop open so the process stays the pane's foreground process.
setInterval(() => { /* keeps this process alive until SIGKILL */ }, 1 << 30);
