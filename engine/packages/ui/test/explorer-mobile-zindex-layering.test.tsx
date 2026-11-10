// Retained Explorer drawers stay above the mobile rail tray.

import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Explorer } from "../src/components/Explorer.js";
import type { ExplorerSurface } from "../src/components/Explorer.js";
import { createAppTestRouter } from "./helpers/test-router.js";

afterEach(() => {
  cleanup();
});

function renderExplorerAt(surface: ExplorerSurface, initialPath: string) {
  return render(
    createAppTestRouter({
      initialPath,
      routes: [
        {
          path: initialPath,
          component: () => (
            <Explorer
              open={true}
              onClose={() => {}}
              selection={null}
              onSelect={() => {}}
              desktopMode="full"
              surface={surface}
            />
          ),
        },
      ],
    }),
  );
}

const MOBILE_RAIL_TRAY_Z = 30; // packages/ui/src/components/AppShell.tsx L560
const EXPLORER_REPAIRED_OPAQUE_Z = 40; // slice 26.B HG-8 OPT-B bumped value

describe("Explorer mobile drawer z-index layering (slice 26.B HG-8 OPT-B repair)", () => {
  // CROSS-DESTINATION assertion: the Explorer.tsx z-index change
  // applies to ALL Explorer-bearing surfaces — verifying for each
  // proves the fix is structural, not surface-specific.
  const opaqueSurfaces: ExplorerSurface[] = ["project", "specs", "settings"];

  for (const surface of opaqueSurfaces) {
    describe(`surface=${surface} (opaque-mode)`, () => {
      it(`Explorer aside has z-40 class (above mobile-rail-tray z-30) — POSITIVE assertion`, async () => {
        renderExplorerAt(surface, "/path-for-test");
        await waitFor(() => {
          expect(screen.getByTestId("explorer")).toBeTruthy();
        });
        const explorer = screen.getByTestId("explorer");
        // Repaired class contract: z-40 is present
        expect(explorer.className).toMatch(/\bz-40\b/);
      });

      it(`Explorer aside does NOT have z-20 class — NEGATIVE assertion (pre-repair broken value absent)`, async () => {
        renderExplorerAt(surface, "/path-for-test");
        await waitFor(() => {
          expect(screen.getByTestId("explorer")).toBeTruthy();
        });
        const explorer = screen.getByTestId("explorer");
        // Pre-repair broken value: z-20 must NOT appear; would
        // re-introduce the rail-tray-covers-Explorer bug
        expect(explorer.className).not.toMatch(/\bz-20\b/);
      });

      it(`Explorer aside z-index value is numerically greater than mobile-rail-tray z-index (${MOBILE_RAIL_TRAY_Z})`, async () => {
        renderExplorerAt(surface, "/path-for-test");
        await waitFor(() => {
          expect(screen.getByTestId("explorer")).toBeTruthy();
        });
        const explorer = screen.getByTestId("explorer");
        // Discriminating layering invariant: pull the z-N class and
        // verify N > rail-tray-z. Without the repair this would be 20.
        const zMatch = explorer.className.match(/\bz-(\d+)\b/);
        expect(zMatch).toBeTruthy();
        const explorerZ = Number(zMatch![1]);
        expect(explorerZ).toBeGreaterThan(MOBILE_RAIL_TRAY_Z);
        expect(explorerZ).toBe(EXPLORER_REPAIRED_OPAQUE_Z);
      });
    });
  }

});
