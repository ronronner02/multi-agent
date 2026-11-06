#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.GH_STUB_DIR;
const args = process.argv.slice(2);
appendFileSync(join(root, "calls.jsonl"), JSON.stringify(args) + "\n");
writeFileSync(join(root, "token-vars.json"), JSON.stringify(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].filter(key => process.env[key])));
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
  process.stderr.write("! First copy your one-");
  setTimeout(() => {
    process.stderr.write("time code: ABCD-1234\nOpen this URL to continue in your web browser: https://github.com/login/");
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
} else {
  process.stderr.write("ghp_fixture_DO_NOT_EXPOSE: unexpected command\n");
  process.exitCode = 1;
}
