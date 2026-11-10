import React, { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import { OwnerReadError } from "../../hooks/useOwnerSession.js";
import { CreateProject, ProjectsScreen } from "../create-project.js";

const request = vi.fn(), onCreated = vi.fn();
vi.mock("../../hooks/useOwnerSession.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../hooks/useOwnerSession.js")>(), useOwnerSession: () => ({ paired: true, request }),
}));
let cache: QueryClient, failure: string | null, action: string;
const created = { id: "fixture-team", name: "sample", repository: "/home/fixture/sample", seats: [{ role: "lead", client: "claude-code" }] };
beforeEach(() => {
  failure = null; action = "create"; onCreated.mockReset(); request.mockReset();
  request.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/teams") {
      const input = JSON.parse(String(init?.body));
      if (input.dryRun) return input.openExisting
        ? { preview: { repository: input.repository, name: "sample", action: "open", fileCount: 0, excludedPaths: [] } }
        : { preview: { ...input, action, fileCount: 2, excludedPaths: [".env", ".ssh/key"] } };
      if (failure) throw new OwnerReadError(409, failure);
      return { team: created };
    }
    if (path === "/fs/dirs") return { roots: ["/home/fixture"], path: null, directories: [{ name: "fixture", path: "/home/fixture" }] };
    if (path === "/fs/dirs?path=%2Fhome%2Ffixture") return { roots: ["/home/fixture"], path: "/home/fixture", directories: [{ name: "sample", path: "/home/fixture/sample" }] };
    if (path === "/fs/dirs?path=%2Fhome%2Ffixture%2Fsample") return { roots: ["/home/fixture"], path: "/home/fixture/sample", directories: [] };
    throw new Error("Unexpected request: " + path);
  });
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { cleanup(); cache.clear(); vi.unstubAllGlobals(); });

async function show(mode: "create" | "open" = "create") {
  const language = await createInterfaceI18n({ language: "en" });
  function Fixture() {
    const [open, setOpen] = useState(true), opener = useRef<HTMLButtonElement>(null);
    return <div className="team-shell"><button ref={opener} onClick={() => setOpen(true)}>Open</button>
      <CreateProject open={open} mode={mode} onOpenChange={setOpen} onCreated={onCreated} opener={opener} /></div>;
  }
  return render(<QueryClientProvider client={cache}><I18nextProvider i18n={language.instance}><Fixture /></I18nextProvider></QueryClientProvider>);
}
function fill() {
  fireEvent.change(screen.getByRole("textbox", { name: "Folder" }), { target: { value: "/home/fixture/sample" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), { target: { value: "sample" } });
}
async function preview() {
  fill(); fireEvent.click(screen.getByRole("button", { name: "Review files" }));
  await screen.findByText("2 included files");
}

describe("project creation", () => {
  it("requires the file preview and upload consequence before creating a lead-only project", async () => {
    await show(); fill();
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review files" }));
    expect(await screen.findByText("2 included files")).toBeTruthy();
    expect(screen.getByText(".env")).toBeTruthy(); expect(screen.getByText(".ssh/key")).toBeTruthy();
    expect(screen.getByText("Create a private GitHub repository named sample and upload the included files from this folder.")).toBeTruthy();
    expect(request.mock.calls.map(([, init]) => JSON.parse(String(init.body)).dryRun)).toEqual([true]);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(JSON.parse(String(request.mock.calls[1]![1].body))).toEqual({ repository: "/home/fixture/sample", name: "sample" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens an existing local repository without asking for a GitHub upload", async () => {
    await show("open");
    fireEvent.change(screen.getByRole("textbox", { name: "Folder" }), { target: { value: "/home/fixture/sample" } });
    fireEvent.click(screen.getByRole("button", { name: "Review files" }));
    expect(await screen.findByText("Open the existing local project sample without creating a GitHub repository or uploading files.")).toBeTruthy();
    expect(JSON.parse(String(request.mock.calls[0]![1].body))).toEqual({ repository: "/home/fixture/sample", openExisting: true, dryRun: true });
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(JSON.parse(String(request.mock.calls[1]![1].body))).toEqual({ repository: "/home/fixture/sample", name: "sample", openExisting: true });
  });

  it("uses the desktop picker when present instead of reading browser directories", async () => {
    const pickFolder = vi.fn().mockResolvedValue("/mnt/d/Client Work/sample");
    vi.stubGlobal("multiAgentDesktop", { pickFolder }); await show();
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Folder" })).toHaveProperty("value", "/mnt/d/Client Work/sample"));
    expect(pickFolder).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled();
  });

  it("preserves the folder on native picker cancellation and surfaces picker failure", async () => {
    const pickFolder = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("native failure"));
    vi.stubGlobal("multiAgentDesktop", { pickFolder }); await show(); fill();
    const browse = screen.getByRole("button", { name: "Browse…" });
    fireEvent.click(browse);
    await waitFor(() => expect(browse).toHaveProperty("disabled", false));
    expect(screen.getByRole("textbox", { name: "Folder" })).toHaveProperty("value", "/home/fixture/sample");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(browse);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "The folder picker did not return a supported folder. Try again.");
    expect(screen.getByRole("textbox", { name: "Folder" })).toHaveProperty("value", "/home/fixture/sample");
    expect(request).not.toHaveBeenCalled();
  });

  it("returns focus to the Create opener when dismissed", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open" })));
  });

  it("selects a directory through the in-app browser without allowing a root selection", async () => {
    await show(); fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    fireEvent.click(await screen.findByRole("button", { name: "fixture" }));
    expect(await screen.findByRole("button", { name: "sample" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use this folder" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "sample" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Use this folder" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
    expect(screen.getByRole("textbox", { name: "Folder" })).toHaveProperty("value", "/home/fixture/sample");
  });

  it("requires another preview when either input changes or the dialog is reopened", async () => {
    await show(); await preview();
    fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), { target: { value: "next" } });
    expect(screen.queryByRole("region", { name: "Files to send" })).toBeNull();
    await preview();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.queryByRole("region", { name: "Files to send" })).toBeNull();
    expect(screen.getByRole("button", { name: "Review files" })).toBeTruthy();
  });

  it("asks for a different name after a repository collision", async () => {
    failure = "github_repo_exists"; await show(); await preview();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "A GitHub repository already uses that name. Choose another name.");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Project name" })));
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
  });

  it("retries the same project after an interrupted push", async () => {
    failure = "github_push_failed"; await show(); await preview();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText("Retry the initial upload to the private GitHub repository sample.")).toBeTruthy();
    failure = null; fireEvent.click(retry);
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    const creates = request.mock.calls.map(([, init]) => JSON.parse(String(init.body))).filter(body => !body.dryRun);
    expect(creates).toEqual([{ repository: "/home/fixture/sample", name: "sample" }, { repository: "/home/fixture/sample", name: "sample" }]);
  });

  it("states that registering an existing origin uploads nothing", async () => {
    action = "register"; await show(); await preview();
    expect(screen.getByText("Register sample with its existing origin. No repository is created and no files are uploaded.")).toBeTruthy();
  });

  it("names the files that are too large and asks for another review", async () => {
    request.mockImplementationOnce(async () => {
      throw new OwnerReadError(400, "team_file_too_large", { oversizedPaths: ["assets/recording.mp4"] });
    });
    await show(); fill();
    fireEvent.click(screen.getByRole("button", { name: "Review files" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent",
      "Files over 100 MiB cannot be uploaded to GitHub. Remove them or add them to the project's ignore file, then review the files again.");
    expect(screen.getByText("Files that are too large")).toBeTruthy();
    expect(screen.getByText("assets/recording.mp4")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review files" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
  });

  it("keeps the target fixed while a preview is pending", async () => {
    let finish!: (value: object) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await show(); fill(); fireEvent.click(screen.getByRole("button", { name: "Review files" }));
    expect(screen.getByRole("textbox", { name: "Folder" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("textbox", { name: "Project name" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Close" })).toHaveProperty("disabled", true);
    await act(async () => finish({ preview: { repository: "/home/fixture/sample", name: "sample", action, fileCount: 2, excludedPaths: [] } }));
    expect(screen.getByRole("button", { name: "Create" })).toHaveProperty("disabled", false);
  });
});


describe("project selection", () => {
  it("offers a separate existing-project action", async () => {
    const language = await createInterfaceI18n({ language: "en" }), onOpenExisting = vi.fn();
    render(<I18nextProvider i18n={language.instance}><ProjectsScreen teams={[]} runs={[]} loading={false}
      onOpenProject={() => {}} onOpenRun={() => {}} onNewWork={() => {}} onCreate={() => {}} onOpenExisting={onOpenExisting} /></I18nextProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    expect(onOpenExisting).toHaveBeenCalledOnce();
  });
});

describe("project record status", () => {
  it.each([
    { state: "approved" as const, resultCount: 0, label: "Approved" },
    { state: "approved" as const, resultCount: 2, label: "Approved" },
    { state: "blocked" as const, resultCount: 1, label: "Blocked" },
    { state: "canceled" as const, resultCount: 1, label: "Canceled" },
  ])("shows $state authority and $resultCount recorded results without inferring activity", async ({ state, resultCount, label }) => {
    const language = await createInterfaceI18n({ language: "en" }), onOpenRun = vi.fn();
    render(<I18nextProvider i18n={language.instance}><ProjectsScreen
      teams={[{ id: "project", name: "Fixture", repository: "/fixture", seats: [] }]}
      runs={[{ id: "record", rigId: "project", rigName: "Fixture", displayName: "Retained work", state,
        phase: "delivery", planRef: "plan.md", createdAt: "2026-11-08", resultCount }]}
      loading={false} onOpenProject={() => {}} onOpenRun={onOpenRun} onNewWork={() => {}} onCreate={() => {}}
    /></I18nextProvider>);
    const record = screen.getByRole("button", { name: /Retained work/ });
    expect(record.textContent).toContain(`Execution · ${label}`);
    expect(record.textContent).not.toMatch(/Running|Idle|Done/);
    if (resultCount > 0) expect(record.textContent).toContain(`${resultCount} integrated results`);
    else expect(record.textContent).not.toContain("integrated results");
    fireEvent.click(record);
    expect(onOpenRun).toHaveBeenCalledWith("record");
  });
});
