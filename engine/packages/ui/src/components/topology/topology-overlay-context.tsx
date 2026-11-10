// Shared rig expansion state for project graphs and retained rig detail routes.

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { useRouterState } from "@tanstack/react-router";

interface TopologyOverlayContextValue {
  /** V1 polish slice Phase 5.2 — rig-expanded state persisted at provider
   *  scope so HostMultiRigGraph mount/unmount cycles don't reset the
   *  collapse map. Default empty → all rigs collapsed. */
  expandedRigs: ReadonlyMap<string, boolean>;
  /** Idempotent setter: explicitly mark a rig expanded or collapsed.
   *  Used by the URL-driven auto-expand effect (always sets true) and
   *  by direct programmatic control. */
  setRigExpanded: (rigId: string, expanded: boolean) => void;
  /** Click-toggle: flip a rig's expanded state. Used by RigGroupNode
   *  body click. */
  toggleRig: (rigId: string) => void;
}

const TopologyOverlayContext = createContext<TopologyOverlayContextValue>({
  expandedRigs: new Map(),
  setRigExpanded: () => {},
  toggleRig: () => {},
});

/** Identify the retained rig detail route for graph expansion. */
export function parseActiveRigId(pathname: string): string | null {
  const rig = pathname.match(/^\/rigs\/([^/]+)(?:\/|$)/);
  return rig ? decodeURIComponent(rig[1]!) : null;
}

export function TopologyOverlayProvider({ children }: { children: ReactNode }) {
  const [expandedRigs, setExpandedRigs] = useState<Map<string, boolean>>(
    () => new Map(),
  );
  const setRigExpanded = useCallback((rigId: string, expanded: boolean) => {
    setExpandedRigs((prev) => {
      if (prev.has(rigId) && prev.get(rigId) === expanded) return prev;
      const next = new Map(prev);
      next.set(rigId, expanded);
      return next;
    });
  }, []);
  const toggleRig = useCallback((rigId: string) => {
    setExpandedRigs((prev) => {
      const next = new Map(prev);
      next.set(rigId, !(prev.get(rigId) ?? false));
      return next;
    });
  }, []);

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    const rigId = parseActiveRigId(pathname);
    if (rigId) setRigExpanded(rigId, true);
  }, [pathname, setRigExpanded]);

  const value = useMemo<TopologyOverlayContextValue>(
    () => ({ expandedRigs, setRigExpanded, toggleRig }),
    [expandedRigs, setRigExpanded, toggleRig],
  );

  return (
    <TopologyOverlayContext.Provider value={value}>
      {children}
    </TopologyOverlayContext.Provider>
  );
}

export function useTopologyOverlay(): TopologyOverlayContextValue {
  return useContext(TopologyOverlayContext);
}
