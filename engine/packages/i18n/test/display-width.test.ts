import { describe, expect, it } from "vitest";
import { displayWidth } from "../src/display-width.js";

describe("terminal display width", () => {
  it.each([
    ["", 0],
    ["task", 4],
    ["中文", 4],
    ["A中🙂", 5],
    ["ＡＢ", 4],
    ["한글", 4],
    ["e\u0301", 1],
    ["\u0301", 0],
    ["👩🏽‍💻", 2],
    ["👨‍👩‍👧‍👦", 2],
    ["🇨🇳", 2],
    ["1️⃣", 2],
    ["♥️", 2],
    ["·", 1],
    ["\u200b", 0],
    ["\u0000\u0007", 0],
    ["\u001b[31m中文\u001b[0m", 4],
    ["\u001b]8;;https://example.invalid\u0007中文\u001b]8;;\u0007", 4],
  ])("measures %j as %i terminal cells", (text, cells) => {
    expect(displayWidth(text)).toBe(cells);
  });
});
