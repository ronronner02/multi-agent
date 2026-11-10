import { describe, expect, it } from "vitest";
import { parentFolder } from "../folder-browser.js";

/**
 * R15 — the folder browser is shared with a Windows daemon.
 *
 * The browser walks paths the daemon reported, and the daemon reports them in its own spelling.
 * Splitting on `/` alone made every `C:\…` path look like one segment with no parent, which
 * removed the Up control on the host this unit exists for.
 */
describe("folder browser parent", () => {
  it.each([
    ["C:\\Users\\owner\\project", "C:\\Users\\owner"],
    ["C:\\Users\\owner", "C:\\Users"],
    ["C:/Users/owner/project", "C:/Users/owner"],
    ["C:\\Users", "C:\\"],
    ["C:/Users", "C:/"],
    ["/home/owner/project", "/home/owner"],
    ["/home", "/"],
  ])("steps up from %s to %s", (path, parent) => {
    expect(parentFolder(path)).toBe(parent);
  });

  it("reports no parent for a path with no separator", () => {
    expect(parentFolder("project")).toBeNull();
  });
});
