import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { routeTree } from "../src/routes.js";

afterEach(() => cleanup());

describe("retained route boundary", () => {
  it.each(["/project", "/terminal"])("renders the small not-found view for deleted URL %s", async path => {
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: [path] }),
      defaultPendingMinMs: 0,
    });
    await act(async () => {
      render(<RouterProvider router={router} />);
      await router.load();
    });

    const view = screen.getByTestId("not-found");
    expect(view).toBeTruthy();
    expect(view.textContent).toBe("Team");
    expect(screen.getByRole("link", { name: "Team" }).getAttribute("href")).toBe("/team");
  });
});
