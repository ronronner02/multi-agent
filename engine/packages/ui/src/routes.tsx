import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Navigate,
  Outlet,
} from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/query-client.js";
import { TeamShell } from "./team/shell.js";

function NotFound() {
  return (
    <main data-testid="not-found">
      <Link to="/team">Team</Link>
    </main>
  );
}

const rootRoute = createRootRoute({
  component: () => (
    <QueryClientProvider client={queryClient}>
      <Outlet />
    </QueryClientProvider>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => <Navigate to="/team" search={{ run: undefined }} />,
});

const teamRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/team",
  validateSearch: (search: Record<string, unknown>): { run?: string; q?: string; task?: string; team?: string } => ({
    run: typeof search.run === "string" ? search.run : undefined,
    q: typeof search.q === "string" && search.q.trim() ? search.q : undefined,
    task: typeof search.task === "string" ? search.task : undefined,
    team: typeof search.team === "string" ? search.team : undefined,
  }),
  component: TeamShell,
});

const teamPageRoute = createRoute({
  getParentRoute: () => teamRoute,
  path: "$section",
  component: () => null,
});

const notFoundRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "$",
  component: NotFound,
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  teamRoute.addChildren([teamPageRoute]),
  notFoundRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
