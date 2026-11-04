// The cancellation demo's live client: it holds the pane until it is signalled.
//
// A managed agent is now one headless turn that ends by itself, so it cannot be the subject of
// a cancel — there would be nothing left to stop. Cancellation is about a process that is still
// working when the owner asks for it, so this stands in for that process and exits on SIGTERM
// the way an ordinary client does. The escalation case uses `resistant-client.mjs`, which
// ignores SIGTERM on purpose.
setInterval(() => { /* hold the pane open until a signal ends it */ }, 1 << 30);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => process.exit(0));
}
