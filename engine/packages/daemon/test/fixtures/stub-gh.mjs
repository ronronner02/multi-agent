#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// U9: the stub supports two invocation forms:
//   1. Direct: gh <args>  (POSIX shebang)
//   2. Via node: node gh.mjs <args>  (Windows, through process.execPath)
// In form 2, process.argv[1] is this script, and process.argv[2] onward are the gh args.
// In some cases (through execArgv), the script name may appear in argv differently.
let args = process.argv.slice(2);
// Strip any leading argument that is the script path itself (Windows execFile form).
while (args.length > 0 && (args[0] === process.argv[1] || args[0].endsWith(".mjs"))) {
  args = args.slice(1);
}
const root = process.env.GH_STUB_DIR;
appendFileSync(join(root, "calls.jsonl"), JSON.stringify(args) + "\n");
appendFileSync(join(root, "proxy.log"), (process.env.HTTPS_PROXY ?? "") + "\n");
writeFileSync(join(root, "token-vars.json"), JSON.stringify(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_TOKEN"].filter(key => process.env[key])));
const account = join(root, "account");
async function waitForRelease(stage) {
  if (!existsSync(join(root, "hold-" + stage))) return;
  while (!existsSync(join(root, "release-" + stage))) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
if (args[0] === "--version") {
  console.log("gh version 2.103.3");
} else if (args[0] === "auth" && args[1] === "status") {
  const signedIn = existsSync(account);
  const validationError = join(root, "validation-error");
  const state = existsSync(validationError) ? "error" : "success";
  console.log(JSON.stringify({ hosts: { "github.com": signedIn
    ? [{ state, host: "github.com", login: "octocat", active: true, token: "ghp_fixture_DO_NOT_EXPOSE" }]
    : [] } }));
  process.exitCode = existsSync(validationError) ? Number(readFileSync(validationError, "utf8")) : signedIn ? 0 : 1;
} else if (args[0] === "auth" && args[1] === "login") {
  if (existsSync(join(root, "early-failure"))) {
    process.stderr.write("ghp_fixture_DO_NOT_EXPOSE: device flow unavailable\n");
    process.exit(1);
  }
  writeFileSync(join(root, "login.pid"), String(process.pid));
  const clipboard = existsSync(join(root, "clipboard-code"));
  process.stderr.write(clipboard ? "! One-" : "! First copy your one-");
  setTimeout(() => {
    process.stderr.write((clipboard ? "time code (ABCD-1234) copied to clipboard" : "time code: ABCD-1234")
      + "\nOpen this URL to continue in your web browser: https://github.com/login/");
    setTimeout(() => process.stderr.write("device\n"), 10);
  }, 10);
  const timer = setInterval(() => {
    const done = join(root, "finish");
    if (!existsSync(done)) return;
    clearInterval(timer);
    if (readFileSync(done, "utf8") !== "done") {
      process.stderr.write("ghp_fixture_DO_NOT_EXPOSE: provider rejected the login\n");
      process.exit(1);
    }
    writeFileSync(account, "octocat");
    process.exit(0);
  }, 20);
  process.on("SIGTERM", async () => {
    clearInterval(timer);
    writeFileSync(join(root, "login-stopped"), "stopped");
    await waitForRelease("login-close");
    process.exit(0);
  });
} else if (args[0] === "auth" && args[1] === "logout") {
  writeFileSync(join(root, "logout-started"), "started");
  await waitForRelease("logout");
  if (existsSync(account)) unlinkSync(account);
} else if (args[0] === "api" && args[1] === "user") {
  if (!existsSync(account)) process.exit(1);
  console.log(JSON.stringify({ login: "octocat", name: "Fixture Owner", id: 123 }));
} else if (args[0] === "api" && args[1] === "rate_limit") {
  if (existsSync(join(root, "proxy-failure"))) {
    process.exit(1);
  }
  // Use rate-limiting marker to simulate proxy unreachable (exit 1 without stderr vs timeout)
  if (existsSync(join(root, "proxy-timeout"))) {
    process.stderr.write("Error: connection timed out (proxy)\n");
    process.exit(1);
  }
  console.log(JSON.stringify({ rate: { remaining: 42, limit: 5000 } }));
} else if (args[0] === "repo" && args[1] === "create") {
  if (existsSync(join(root, "repo-exists"))) {
    process.stderr.write("ghp_fixture_DO_NOT_EXPOSE: Name already exists on this account\n");
    process.exit(1);
  }
  if (existsSync(join(root, "repo-failure"))) {
    process.stderr.write("ghp_fixture_DO_NOT_EXPOSE: network unavailable\n");
    process.exit(1);
  }
  const source = args[args.indexOf("--source") + 1];
  const url = "https://github.com/" + args[2] + ".git";
  execFileSync("git", ["-C", source, "remote", "add", "origin", url]);
  console.log(url);
} else if (args[0] === "repo" && args[1] === "view") {
  // Simulate not-found transient failure after create.
  if (existsSync(join(root, "view-not-found"))) {
    process.stderr.write("ghp_fixture_DO_NOT_EXPOSE: Repository not found.\n");
    process.exit(1);
  }
  // Simulate view timeout
  if (existsSync(join(root, "view-timeout"))) {
    process.stderr.write("ghp_fixture_DO_NOT_EXPOSE: could not read: timeout\n");
    process.exit(1);
  }
  console.log(JSON.stringify({ nameWithOwner: args[2], isPrivate: !existsSync(join(root, "repo-public")) }));
} else {
  process.stderr.write("ghp_fixture_DO_NOT_EXPOSE: unexpected command\n");
  process.exitCode = 1;
}
