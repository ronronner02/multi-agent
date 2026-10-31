import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { createInterfaceI18n } from "@openrig/i18n";
import { ResultPanel, changedPaths } from "../result-panel.js";

// MVP slice 3 — the result panel shows what a finished task's patch moves and the command that
// applies it. The daemon is faked at the owner-session seam; the panel is real.

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../hooks/useOwnerSession.js", async importOriginal => ({ ...(await importOriginal<object>()),
  useOwnerSession: () => ({ paired: true, request: mocks.request }),
}));

const PATCH = ["diff --git a/src/result.ts b/src/result.ts", "new file mode 100644", "--- /dev/null",
  "+++ b/src/result.ts", "@@ -0,0 +1 @@", "+export const result = 42;", ""].join("\n");
const result = { schema: "multi-agent-team-result/v1", runId: "run", taskId: "task", attemptId: "attempt-1",
  repositoryRoot: "/repo", base: "commit", baseIdentifier: "a".repeat(40),
  manifestDigest: "sha256:" + "b".repeat(64), files: [], patch: PATCH };

afterEach(() => { cleanup(); mocks.request.mockReset(); });

it("shows the changed file, the diff and the apply command for a finished task", async () => {
  const language = await createInterfaceI18n({ preference: { read: () => "en", write() {} } });
  mocks.request.mockResolvedValue({ result });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={cache}><I18nextProvider i18n={language.instance}>
    <div className="team-shell"><ResultPanel runId="run" taskId="task" /></div>
  </I18nextProvider></QueryClientProvider>);
  const panel = await screen.findByRole("region", { name: language.t("web.result") });
  expect(await screen.findByText("src/result.ts")).toBeTruthy();
  expect(panel.querySelector("pre")?.textContent).toBe(PATCH);
  expect(panel.textContent).toContain("rig team apply run --task task");
  expect(mocks.request).toHaveBeenCalledWith("/runs/run/tasks/task/result", expect.anything());
  // The changed paths come from the patch's own headers, not a second manifest.
  expect(changedPaths(PATCH)).toEqual(["src/result.ts"]);
  expect(changedPaths("")).toEqual([]);
});
