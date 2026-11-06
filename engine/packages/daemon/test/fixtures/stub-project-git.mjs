#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const executable = process.env.GH_STUB_REAL_GIT;
if (args.includes("push")) {
  const repository = args[args.indexOf("-C") + 1];
  const read = (...command) => execFileSync(executable, ["-C", repository, ...command], { encoding: "utf8" }).trim();
  const origin = read("config", "--get", "remote.origin.url");
  const target = args[args.indexOf("--", args.indexOf("push")) + 1];
  const effective = target === "origin" ? read("remote", "get-url", "--push", "--all", "origin")
    : read("-c", "remote.project-fixture-transport.url=" + target, "remote", "get-url", "--push", "project-fixture-transport");
  // Replace only the intended fixture transport, after production destination validation.
  // A repository-configured redirect stays intact so regressions exercise real Git behavior.
  if (effective === origin && /^https:\/\/github\.com\/octocat\/[a-z\d_.-]+\.git$/i.test(origin)) {
    args.unshift("-c", "url." + process.env.GH_STUB_REMOTE + ".insteadOf=" + origin);
  }
}
const result = spawnSync(executable, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
