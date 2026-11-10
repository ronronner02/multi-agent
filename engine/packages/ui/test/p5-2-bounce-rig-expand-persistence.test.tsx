// Shared graph expansion persists across retained rig detail navigation.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  TopologyOverlayProvider,
  useTopologyOverlay,
  parseActiveRigId,
} from "../src/components/topology/topology-overlay-context.js";
import { HostMultiRigGraph } from "../src/components/topology/HostMultiRigGraph.js";

const navigateSpy = vi.fn();
vi.mock("@tanstack/react-router", async (importActual) => {
  const actual = await importActual<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  };
});

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  navigateSpy.mockClear();
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string) => {
    if (url === "/api/ps") {
      return new Response(
        JSON.stringify([
          {
            rigId: "rig-1",
            name: "openrig-velocity",
            nodeCount: 13,
            runningCount: 9,
            status: "running",
            uptime: null,
            latestSnapshot: null,
          },
          {
            rigId: "rig-2",
            name: "openrig-discovery",
            nodeCount: 5,
            runningCount: 3,
            status: "partial",
            uptime: null,
            latestSnapshot: null,
          },
        ]),
      );
    }
    if (url.match(/\/api\/rigs\/[^/]+\/graph/)) {
      return new Response(JSON.stringify({ nodes: [], edges: [] }));
    }
    return new Response("[]");
  });
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------
// parseActiveRigId — pure-fn
// ---------------------------------------------------------------------

describe("parseActiveRigId (P5.2 bounce-fix pure-fn)", () => {
  it("matches /rigs/$rigId/nodes/$logicalId", () => {
    expect(parseActiveRigId("/rigs/rig-1/nodes/orch.lead")).toBe("rig-1");
  });
  it("matches /rigs/$rigId", () => {
    expect(parseActiveRigId("/rigs/rig-1")).toBe("rig-1");
  });
  it("returns null for /topology root", () => {
    expect(parseActiveRigId("/topology")).toBe(null);
  });
  it("returns null for non-topology routes", () => {
    expect(parseActiveRigId("/project")).toBe(null);
    expect(parseActiveRigId("/for-you")).toBe(null);
    expect(parseActiveRigId("/")).toBe(null);
  });
  it("decodes URL-encoded rigIds", () => {
    expect(parseActiveRigId("/rigs/rig%2D1/nodes/seat%2Da")).toBe("rig-1");
  });
});

// ---------------------------------------------------------------------
// Helpers — render with router on a specific initial path
// ---------------------------------------------------------------------

function renderAt(initialPath: string, ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => (
      <TopologyOverlayProvider>
        <Outlet />
      </TopologyOverlayProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/topology",
    component: () => <>{ui}</>,
  });
  const seatRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/rigs/$rigId/nodes/$logicalId",
    component: () => <>{ui}</>,
  });
  const rigRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/rigs/$rigId",
    component: () => <>{ui}</>,
  });
  const fallback = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, seatRoute, rigRoute, fallback]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  return {
    router,
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  };
}

// ---------------------------------------------------------------------
// Provider auto-expand useEffect — fires regardless of mount state of
// HostMultiRigGraph (the design-reviewer dead-code bug fix).
// ---------------------------------------------------------------------

function ContextProbe() {
  // Tiny consumer that exposes the context's expandedRigs as testid
  // attributes the test can inspect.
  const ctx = useTopologyOverlay();
  return (
    <div
      data-testid="topology-context-probe"
      data-expanded-rigs={Array.from(ctx.expandedRigs.entries())
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(",")}
    />
  );
}

describe("TopologyOverlayProvider auto-expand on URL (P5.2 bounce-fix)", () => {
  it("/rigs/$rigId direct-URL entry sets expandedRigs in provider state (HostMultiRigGraph NOT mounted)", async () => {
    // Probe-only render — HostMultiRigGraph is NOT mounted on this path,
    // proving the provider effect fires regardless of which scope page
    // is currently the center component.
    const { findByTestId } = renderAt("/rigs/rig-1", <ContextProbe />);
    const probe = await findByTestId("topology-context-probe");
    await waitFor(() => {
      expect(probe.getAttribute("data-expanded-rigs")).toBe("rig-1");
    });
  });

  it("/rigs/$rigId/nodes/$logicalId sets the matching rig expanded", async () => {
    const { findByTestId } = renderAt(
      "/rigs/rig-2/nodes/orch.lead",
      <ContextProbe />,
    );
    const probe = await findByTestId("topology-context-probe");
    await waitFor(() => {
      expect(probe.getAttribute("data-expanded-rigs")).toBe("rig-2");
    });
  });

  it("/topology root pathname does NOT write explicit expansion overrides", async () => {
    const { findByTestId } = renderAt("/topology", <ContextProbe />);
    const probe = await findByTestId("topology-context-probe");
    // Allow the render to settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(probe.getAttribute("data-expanded-rigs")).toBe("");
  });
});

// ---------------------------------------------------------------------
// HostMultiRigGraph reads from context — cross-mount persistence
// ---------------------------------------------------------------------

describe("HostMultiRigGraph reads expandedRigs from context (P5.2 bounce-fix persistence)", () => {
  it("when context has rigId=false on mount, only that rig renders collapsed", async () => {
    // Custom probe that pre-sets an explicit collapse then mounts the graph.
    function PreCollapsedHarness() {
      const { setRigExpanded } = useTopologyOverlay();
      // Fire the pre-collapse once on mount (simulates the operator
      // collapsing a rig, navigating away, then returning to /topology).
      // useEffect intentionally not used here — the test just calls in
      // an effect via setTimeout so React batches commit before render.
      if (typeof window !== "undefined") {
        // Idempotent: subsequent renders won't double-set.
        queueMicrotask(() => setRigExpanded("rig-2", false));
      }
      return <HostMultiRigGraph />;
    }

    const { findByTestId } = renderAt("/topology", <PreCollapsedHarness />);
    const node = await findByTestId("rig-group-node-rig-2");
    await waitFor(() => {
      expect(node.getAttribute("data-collapsed")).toBe("true");
    });
    // Other rig remains expanded by default.
    const otherRig = await findByTestId("rig-group-node-rig-1");
    expect(otherRig.getAttribute("data-collapsed")).toBe("false");
  });

  it("when no rig has an explicit context override, all rigs render expanded", async () => {
    const { findByTestId } = renderAt("/topology", <HostMultiRigGraph />);
    const r1 = await findByTestId("rig-group-node-rig-1");
    const r2 = await findByTestId("rig-group-node-rig-2");
    expect(r1.getAttribute("data-collapsed")).toBe("false");
    expect(r2.getAttribute("data-collapsed")).toBe("false");
  });
});

// ---------------------------------------------------------------------
// Source-assertion guards — ensure dead-code path doesn't reappear
// ---------------------------------------------------------------------

describe("source-assertion guards (P5.2 bounce-fix coupled-literal scan)", () => {
  it("HostMultiRigGraph reads expanded from useTopologyOverlay (NOT local useState)", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.resolve(
        __dirname,
        "../src/components/topology/HostMultiRigGraph.tsx",
      ),
      "utf8",
    );
    // Positive: consumes the context.
    expect(src).toContain("useTopologyOverlay");
    expect(src).toMatch(/useTopologyOverlay\(\s*\)/);
    // Negative: no local useState for expanded Map. The dead-code bug
    // returning if this regresses.
    expect(src).not.toMatch(/useState<Map<string,\s*boolean>>/);
  });

  it("topology-overlay-context.tsx exposes expandedRigs + setRigExpanded + toggleRig + parseActiveRigId", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.resolve(
        __dirname,
        "../src/components/topology/topology-overlay-context.tsx",
      ),
      "utf8",
    );
    expect(src).toContain("expandedRigs");
    expect(src).toContain("setRigExpanded");
    expect(src).toContain("toggleRig");
    expect(src).toContain("export function parseActiveRigId");
    // Provider auto-expand useEffect on pathname.
    expect(src).toMatch(/useRouterState/);
    expect(src).toMatch(/parseActiveRigId\s*\(/);
  });
});
