import { expect, it } from "vitest";
import { bindingCovers } from "../src/domain/binding-scope.js";

it.each(["package.json", "package-lock.json", "index.html", "server", "server/main.ts", "client/main.ts", "test/app.test.ts"])(
  "covers an ordinary concrete path in the selected project: %s", path => {
    expect(bindingCovers(path, ["."])).toBe(true);
  });

it.each([".", "..", "../outside.ts", "/outside.ts", "C:/outside.ts", "server/../secret", "server//main.ts", "./server", "server/**"])(
  "keeps unnormalized and external paths outside project scope: %s", path => {
    expect(bindingCovers(path, ["."])).toBe(false);
  });

it.each([".env", "server/.env.local", ".git/config", ".ssh/id_rsa", "server/private.key",
  ".github/workflows/build.yml", "docs/plans/approved.md", "server/contracts/auth.ts", "server/migrations/001.sql",
  "engine/config/governance/credential-exclusions.json", "engine/packages/daemon/src/domain/binding-scope.ts"])(
  "does not infer a protected-path grant from the project marker: %s", path => {
    expect(bindingCovers(path, ["."])).toBe(false);
  });

it("preserves explicit owner grants and rejects sibling-prefix matches", () => {
  expect(bindingCovers("src/main.ts", ["src"])).toBe(true);
  expect(bindingCovers("src-other/main.ts", ["src"])).toBe(false);
  expect(bindingCovers("server/main.ts", ["src"])).toBe(false);
  expect(bindingCovers("docs/plans/approved.md", ["docs/plans/approved.md", "."])).toBe(true);
  expect(bindingCovers("docs/plans/unapproved.md", ["docs/plans/approved.md", "."])).toBe(false);
});
