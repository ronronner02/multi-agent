import React, { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInterfaceI18n } from "@multi-agent/i18n";
import { I18nextProvider } from "react-i18next";
import type { WorkflowSelection } from "@multi-agent/daemon/team-control";
import { FRAMEWORK_CATALOG } from "../../../../daemon/dist/integrations/framework/catalog.js";
import { SoulSettings } from "../soul-settings.js";
import { WorkflowOutcomes, WorkflowPicker } from "../workflows.js";

const request = vi.fn();
vi.mock("../../hooks/useOwnerSession.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../hooks/useOwnerSession.js")>(),
  useOwnerSession: () => ({ paired: true, request }),
}));
let cache: QueryClient;
beforeEach(() => { request.mockReset(); cache = new QueryClient({ defaultOptions: { queries: { retry: false } } }); });
afterEach(() => { cleanup(); cache.clear(); });
async function show(element: React.ReactNode, selectedLanguage: "en" | "zh-CN" = "en") {
  const language = await createInterfaceI18n({ language: selectedLanguage });
  render(<QueryClientProvider client={cache}><I18nextProvider i18n={language.instance}>{element}</I18nextProvider></QueryClientProvider>);
}
const profiles = [
  { id: "engineer", name: "Software engineer", roles: ["implementer"], version: 1, content: "Verify the real behavior.", digest: "a".repeat(64) },
  { id: "frontend", name: "Frontend specialist", roles: ["implementer"], version: 1, content: "Check keyboard access.", digest: "b".repeat(64) },
  { id: "reviewer", name: "Independent reviewer", roles: ["reviewer"], version: 1, content: "Remain report-only.", digest: "c".repeat(64) },
];
describe("specialist and workflow owner controls", () => {
  it("edits a version and assigns only a role-compatible specialist through the owner API", async () => {
    const saved = { profiles: structuredClone(profiles), seats: [{ nodeId: "seat", role: "implementer", soulId: "engineer", member: "impl@project" }] };
    request.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method !== "PUT") return saved;
      const body = JSON.parse(String(init.body));
      if (path.endsWith("/souls/engineer")) return { profile: { ...saved.profiles[0], ...body, version: 2 } };
      if (path.endsWith("/seats/seat/soul")) return { ...saved, seats: [{ ...saved.seats[0], soulId: body.soulId }] };
      throw new Error(path);
    });
    await show(<SoulSettings teamId="project" />);
    fireEvent.change(await screen.findByLabelText("SOUL instructions"), { target: { value: "Use the project-specific checks." } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile version" }));
    await screen.findByRole("option", { name: "Software engineer · v2" });
    expect(request).toHaveBeenCalledWith("/teams/project/souls/engineer", expect.objectContaining({ method: "PUT",
      body: JSON.stringify({ expectedVersion: 1, name: "Software engineer", roles: ["implementer"], content: "Use the project-specific checks." }) }));
    const seat = screen.getByLabelText("Seat 1 · Implementer");
    expect(within(seat).queryByRole("option", { name: "Independent reviewer" })).toBeNull();
    fireEvent.change(seat, { target: { value: "frontend" } });
    await waitFor(() => expect((screen.getByLabelText("Seat 1 · Implementer") as HTMLSelectElement).value).toBe("frontend"));
    expect(request).toHaveBeenCalledWith("/teams/project/seats/seat/soul", expect.objectContaining({ method: "PUT" }));
  });
  it("localizes specialist controls and built-in choices while preserving edited identity data", async () => {
    request.mockResolvedValue({ profiles: [profiles[0], { ...profiles[1], name: "My interface specialist", version: 2 },
      { ...profiles[0], id: "research", name: "Owner research identity" }], seats: [] });
    await show(<SoulSettings teamId="project" />, "zh-CN");
    const picker = await screen.findByLabelText("专家身份");
    expect(within(picker).getByRole("option", { name: "软件工程师 · v1" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "专家身份（SOUL）" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "添加专家" })).toBeTruthy();
    expect((screen.getByLabelText("身份名称") as HTMLInputElement).value).toBe("Software engineer");
    expect((screen.getByLabelText("SOUL 指令") as HTMLTextAreaElement).value).toBe("Verify the real behavior.");
    fireEvent.change(picker, { target: { value: "frontend" } });
    expect((screen.getByLabelText("身份名称") as HTMLInputElement).value).toBe("My interface specialist");
    expect(within(picker).getByRole("option", { name: "Owner research identity · v1" })).toBeTruthy();
  });
  it("lists all 38 workflows while keeping caller helpers distinct and code review read-only", async () => {
    request.mockResolvedValue({ workflows: FRAMEWORK_CATALOG });
    function Picker() {
      const [value, onChange] = useState<WorkflowSelection>();
      return <WorkflowPicker value={value} onChange={onChange} />;
    }
    await show(<Picker />);
    const picker = await screen.findByLabelText("Workflow");
    await waitFor(() => expect(within(picker).getAllByRole("option")).toHaveLength(39));
    expect((within(picker).getByRole("option", { name: "spec-commit · Caller only" }) as HTMLOptionElement).disabled).toBe(true);
    fireEvent.change(picker, { target: { value: "spec-code-review" } });
    const readonly = screen.getByRole("checkbox", { name: "Read-only execution" }) as HTMLInputElement;
    expect(readonly.checked).toBe(true); expect(readonly.disabled).toBe(true);
    fireEvent.change(picker, { target: { value: "spec-test-browser" } });
    fireEvent.click(screen.getByText("Execution requirements"));
    expect(screen.getByText(/Browser capability and an exact authorized origin/)).toBeTruthy();
  });
  it("shows pending and blocked native outcomes without presenting them as accepted work", async () => {
    request.mockResolvedValue({ workflows: [
      { taskId: "one", workflow: { entrypoint: "spec-plan" }, outcome: null },
      { taskId: "two", workflow: { entrypoint: "spec-test-xcode" }, outcome: { status: "blocked", reason: "A macOS node is required.", artifacts: [] } },
    ] });
    await show(<WorkflowOutcomes runId="run" />);
    fireEvent.click(await screen.findByText("Workflow outcomes"));
    expect(screen.getByText(/Awaiting a recorded outcome/)).toBeTruthy();
    expect(screen.getByText("A macOS node is required.")).toBeTruthy();
    expect(screen.getByText(/separately from task validation/)).toBeTruthy();
  });
});
