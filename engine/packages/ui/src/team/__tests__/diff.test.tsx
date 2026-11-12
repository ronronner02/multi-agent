import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createInterfaceI18n } from "@multi-agent/i18n";
import { I18nextProvider } from "react-i18next";
import { parsePatch } from "../diff-model.js";
import { DiffView } from "../diff-view.js";


/**
 * Slice B — the one diff surface.
 *
 * The parser is the part that can lie: it turns git's own text into numbers, and a number that
 * drifts from the patch would mislead the owner about what the candidate changed. These cases use
 * real git output shapes, including the two that carry no hunks at all.
 */

const MODIFIED = [
  "diff --git a/src/filter.ts b/src/filter.ts",
  "index 1111111..2222222 100644",
  "--- a/src/filter.ts",
  "+++ b/src/filter.ts",
  "@@ -1,4 +1,5 @@ export function filterItems<T>(items: T[], predicate: (item: T) => boolean): T[] {",
  " export function filterItems<T>(items: T[], predicate: (item: T) => boolean): T[] {",
  "-  return items.filter(item => predicate(item));",
  "+  // The predicate decides; the filter only orders.",
  "+  return items.filter(item => predicate(item));",
  " }",
  "@@ -12,3 +13,3 @@ interface FilterOptions {",
  "   skip?: number;",
  "-  limit: number;",
  "+  limit?: number;",
  "   matchCase?: boolean;",
  "",
].join("\n");

const RENAMED = [
  "diff --git a/src/old-name.ts b/src/new-name.ts",
  "similarity index 92%",
  "rename from src/old-name.ts",
  "rename to src/new-name.ts",
  "index 1111111..2222222 100644",
  "--- a/src/old-name.ts",
  "+++ b/src/new-name.ts",
  "@@ -1 +1 @@",
  "-export const oldName = 1;",
  "+export const newName = 1;",
  "",
].join("\n");

const BINARY = [
  "diff --git a/assets/logo.png b/assets/logo.png",
  "index 1111111..2222222 100644",
  "Binary files a/assets/logo.png and b/assets/logo.png differ",
  "",
].join("\n");

describe("parsePatch", () => {
  it("numbers both sides of a modified file from the hunk headers", () => {
    const [file] = parsePatch(MODIFIED);
    expect(file).toMatchObject({ path: "src/filter.ts", previousPath: null, status: "modified", binary: false, added: 3, removed: 2 });
    expect(file!.hunks).toHaveLength(2);
    const [first] = file!.hunks;
    expect(first!.oldStart).toBe(1);
    expect(first!.newStart).toBe(1);
    // A context line advances both counters; an addition only the new one; a removal only the old.
    expect(first!.lines.map(line => [line.kind, line.oldLine, line.newLine])).toEqual([
      ["context", 1, 1], ["remove", 2, null], ["add", null, 2], ["add", null, 3], ["context", 3, 4],
    ]);
    const second = file!.hunks[1]!;
    expect(second.lines.map(line => [line.kind, line.oldLine, line.newLine])).toEqual([
      ["context", 12, 13], ["remove", 13, null], ["add", null, 14], ["context", 14, 15],
    ]);
    expect(first!.header).toBe("@@ -1,4 +1,5 @@ export function filterItems<T>(items: T[], predicate: (item: T) => boolean): T[] {");
  });

  it("keeps both names of a rename and reads the hunk under the new path", () => {
    const [file] = parsePatch(RENAMED);
    expect(file).toMatchObject({ path: "src/new-name.ts", previousPath: "src/old-name.ts", status: "renamed", added: 1, removed: 1 });
    expect(file!.hunks[0]!.lines.map(line => line.text)).toEqual(["export const oldName = 1;", "export const newName = 1;"]);
  });

  it("marks a binary file and publishes no line counts, because the patch states none", () => {
    const [file] = parsePatch(BINARY);
    expect(file).toMatchObject({ path: "assets/logo.png", status: "modified", binary: true, added: null, removed: null });
    expect(file!.hunks).toEqual([]);
  });

  it("reads an added and a deleted file from /dev/null, and returns nothing for an empty patch", () => {
    const added = parsePatch([
      "diff --git a/src/new.ts b/src/new.ts", "new file mode 100644", "--- /dev/null", "+++ b/src/new.ts",
      "@@ -0,0 +1,2 @@", "+one", "+two", "",
    ].join("\n"));
    expect(added[0]).toMatchObject({ path: "src/new.ts", status: "added", added: 2, removed: 0 });
    const deleted = parsePatch([
      "diff --git a/src/gone.ts b/src/gone.ts", "deleted file mode 100644", "--- a/src/gone.ts", "+++ /dev/null",
      "@@ -1 +0,0 @@", "-gone", "",
    ].join("\n"));
    expect(deleted[0]).toMatchObject({ path: "src/gone.ts", status: "deleted", added: 0, removed: 1 });
    expect(parsePatch("")).toEqual([]);
  });

  it("parses several files in one patch and annotates a missing trailing newline without consuming a number", () => {
    const files = parsePatch(`${MODIFIED}${BINARY}`);
    expect(files.map(file => file.path)).toEqual(["src/filter.ts", "assets/logo.png"]);
    const [file] = parsePatch([
      "diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-one", "\\ No newline at end of file",
      "+two", "\\ No newline at end of file", "",
    ].join("\n"));
    expect(file!.hunks[0]!.lines.map(line => [line.kind, line.oldLine, line.newLine])).toEqual([
      ["remove", 1, null], ["note", null, null], ["add", null, 1], ["note", null, null],
    ]);
  });
});

describe("DiffView", () => {
  async function show(patch: string, locale: "en" | "zh-CN" = "en") {
    const language = await createInterfaceI18n({ language: locale });
    render(<I18nextProvider i18n={language.instance}><div className="team-shell"><DiffView patch={patch} /></div></I18nextProvider>);
    return language;
  }

  it.each(["en", "zh-CN"] as const)("lists the changed files and renders the selected file's numbered lines (%s)", async locale => {
    const language = await show(`${MODIFIED}${BINARY}`, locale);
    const files = screen.getByRole("group", { name: language.t("web.changedFiles") });
    expect(within(files).getAllByRole("button").map(button => button.getAttribute("data-path")))
      .toEqual(["src/filter.ts", "assets/logo.png"]);
    // The first file is selected, so its hunk is the diff the owner reads.
    expect(screen.getByText("@@ -1,4 +1,5 @@ export function filterItems<T>(items: T[], predicate: (item: T) => boolean): T[] {")).toBeTruthy();
    const lines = document.querySelectorAll(".cl");
    expect([...lines].map(line => line.getAttribute("data-kind"))).toEqual(
      [null, "remove", "add", "add", null, null, "remove", "add", null]);
    // The rendered line numbers are the patch's, not a running index.
    expect([...lines][2]!.querySelectorAll(".ln")[1]!.textContent).toBe("2");
    expect([...lines][1]!.querySelectorAll(".ln")[0]!.textContent).toBe("2");
  });

  it("shows a binary file's notice instead of inventing hunks", async () => {
    const language = await show(`${RENAMED}${BINARY}`);
    fireEvent.click(screen.getByRole("button", { name: /logo\.png/ }));
    expect(screen.getByTestId("diff-binary").textContent).toBe(language.t("diff.binaryHint"));
    expect(document.querySelectorAll(".cl")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /new-name\.ts/ }));
    expect(document.querySelectorAll(".cl")).toHaveLength(2);
  });

  it("says the patch is empty rather than drawing an empty frame", async () => {
    const language = await show("");
    expect(screen.getByTestId("diff-empty").textContent).toBe(language.t("team.task.noDiff"));
    expect(screen.queryByTestId("diff-view")).toBeNull();
  });
});
