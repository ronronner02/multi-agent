import React, { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TeamOwnerRead, ControlReceipt, ControlRequest } from "@openrig/daemon/team-control";
import { OwnerSessionProvider, useOwnerSession } from "../src/hooks/useOwnerSession.js";

import { createInterfaceI18n } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import { DecisionCard } from "../src/team/decision-card.js";

const command: ControlRequest = {
  protocolVersion: "1.0", runId: "RUN-001", actionId: "APPROVAL-001",
  expectedEntityVersion: 3, idempotencyKey: "decision-001",
  payload: { approvalVersion: 2, decision: "approved" },
};
const receipt: ControlReceipt = {
  runId: command.runId, entityVersion: 4, status: "accepted", replayed: false,
  effectMayStart: false, value: null, reason: null,
};

function RequestProbe({ read = false }: { read?: boolean }) {
  const { pair, paired, request } = useOwnerSession();
  const [result, setResult] = useState("waiting");
  return <>
    <button onClick={() => void pair("fixture-pairing")}>Pair</button>
    <button disabled={!paired} onClick={async () => {
      try {
        const response = await request<ControlReceipt>(read ? "/runs/RUN-001/read" : "/runs/RUN-001/approvals/decide",
          read ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) });
        setResult(response.status);
      } catch { setResult("rejected"); }
    }}>Send</button>
    <p role="status">{result}</p>
  </>;
}

async function pair() {
  fireEvent.click(screen.getByRole("button", { name: "Pair", exact: true }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false));
}

afterEach(() => vi.unstubAllGlobals());

describe("paired owner request boundary", () => {
  it("accepts the daemon's canonical control receipt without inventing a response protocol field", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ antiForgeryToken: "fixture-csrf" })))
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt)));
    vi.stubGlobal("fetch", fetcher);
    render(<OwnerSessionProvider><RequestProbe /></OwnerSessionProvider>);
    await pair();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("accepted"));
    const [url, init] = fetcher.mock.calls[1]!;
    expect(url).toBe("/api/team-control/runs/RUN-001/approvals/decide");
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).get("X-Multi-Agent-CSRF")).toBe("fixture-csrf");
    expect(JSON.parse(init.body)).toEqual(command);
  });

  it("still rejects a read response without its required protocol version", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ antiForgeryToken: "fixture-csrf" })))
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt))));
    render(<OwnerSessionProvider><RequestProbe read /></OwnerSessionProvider>);
    await pair();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("rejected"));
  });
});

function fixture(): TeamOwnerRead {
  const run: TeamOwnerRead["run"] = {
    id: "RUN-001", rigId: "rig", bindingDigest: "binding", state: "approved", stateReason: null, entityVersion: 3,
    activeMs: 0, accountedAt: null, retriesUsed: 0, reviewRoundsUsed: 0, createdAt: "2026-10-29", updatedAt: "2026-10-29",
    usage: { activeMs: 0, inputTokens: { value: null, reason: null }, outputTokens: { value: null, reason: null }, costUsd: { value: null, reason: null } },
    binding: { artifactContract: "spec-unified-plan/v1", artifactReadiness: "implementation-ready", execution: "code", status: "active",
      planRef: "docs/plan.md", planDigest: "plan-digest", repository: { root: "/fixture", identity: "fixture/repository" },
      readPaths: [], writePaths: [], roles: [], policyRevision: 1, policyFingerprint: "policy",
      limits: { maxSessions: 3, maxActiveMs: 1000, maxRetries: 1, maxReviewRounds: 2 } },
  };
  return { schema: "multi-agent-team-read/v1", protocolVersion: "1.0", runId: run.id, run, generatedAt: new Date().toISOString(),
    workflow: { current: "execution", stages: [] }, tasks: [], attempts: [], logs: [], replay: { retainedFrom: 1, latestSeq: 1 },
    approvals: [{ id: "APPROVAL-001", runId: run.id, kind: "orchestrator", action: "scope-extension", bindingDigest: run.bindingDigest,
      targetDigest: "target", payloadDigest: "payload", entityVersion: 2, state: "pending", decisionActor: null, awaitingDecision: true,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), payload: { taskId: "T020", expectedChainHead: "chain-head", reason: "<img src=x onerror=alert(1)>",
        paths: [{ path: "src/new.ts", operation: "create" }, { path: "src/old.ts", operation: "modify" }],
        classification: "owner-decision", packages: [{ name: "fixture", version: "1.2.3", matched: "approved-list-entry" }] } }],
  };
}

function DecisionProbe(props: React.ComponentProps<typeof DecisionCard>) {
  const { pair } = useOwnerSession();
  return <><button onClick={() => void pair("fixture")}>Pair</button><DecisionCard {...props} /></>;
}

async function mountDecisions(read = fixture(), post: ReturnType<typeof vi.fn> = vi.fn(async () => new Response(JSON.stringify(receipt)))) {
  const language = await createInterfaceI18n({ preference: { read: () => "en", write() {} } });
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => url.endsWith("/exchange")
    ? Promise.resolve(new Response(JSON.stringify({ antiForgeryToken: "fixture-csrf" }))) : post(url, init)));
  const refresh = vi.fn(async () => undefined);
  const onOpenSession = vi.fn();
  const props = { read, available: true, now: Date.now(), refresh, onOpenSession };
  const tree = () => <I18nextProvider i18n={language.instance}><OwnerSessionProvider><div className="team-shell"><DecisionProbe {...props} /></div></OwnerSessionProvider></I18nextProvider>;
  const mounted = render(tree());
  fireEvent.click(screen.getByRole("button", { name: "Pair", exact: true }));
  await act(async () => {});
  return { post, refresh, onOpenSession, update(next: Partial<typeof props>) { Object.assign(props, next); mounted.rerender(tree()); } };
}

const approve = () => { const button = screen.getByRole("button", { name: "Approve", exact: true }); button.focus(); fireEvent.click(button); return button; };
const confirm = () => fireEvent.click(screen.getByRole("button", { name: "Send confirmed decision" }));

describe("version-bound owner decisions", () => {
  it("shows exact scope as inert text, coalesces clicks, and waits for observed state", async () => {
    let resolve!: (value: Response) => void;
    const post = vi.fn((_url: string, _init: RequestInit) => new Promise<Response>(done => { resolve = done; }));
    const read = fixture(); const mounted = await mountDecisions(read, post); const trigger = approve();
    const dialog = await screen.findByRole("dialog");
    for (const text of ["src/new.ts", "create", "src/old.ts", "modify", "1.2.3", "approved-list-entry", "owner-decision", "<img src=x onerror=alert(1)>"]) expect(dialog.textContent).toContain(text);
    expect(dialog.querySelector("img")).toBeNull(); expect(dialog.closest(".team-shell")).toBeTruthy();
    confirm(); confirm(); expect(post).toHaveBeenCalledTimes(1);
    const body = JSON.parse(post.mock.calls[0]![1].body as string);
    expect(body).toMatchObject({ runId: read.run.id, actionId: read.approvals[0]!.id, expectedEntityVersion: 3,
      payload: { approvalVersion: 2, decision: "approved", expectedChainHead: "chain-head" } });
    await act(async () => resolve(new Response(JSON.stringify({ ...receipt, status: "pending-execution" }), { status: 202 })));
    expect(within(dialog).getByRole("status").textContent).toBe("Requested");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close", exact: true }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    fireEvent.click(trigger);
    expect((screen.getByRole("button", { name: "Send confirmed decision" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
    mounted.update({ read: { ...read, approvals: [{ ...read.approvals[0]!, state: "approved" }] } });
    expect(screen.getByText("No pending decisions")).toBeTruthy();
  });

  it.each(["stale", "expired", "binding", "invalidated", "cancel_requested"])("disables %s decisions", async state => {
    const read = fixture();
    if (state === "expired") read.approvals[0]!.expiresAt = new Date(0).toISOString();
    if (state === "binding") read.approvals[0]!.bindingDigest = "different";
    if (state === "invalidated" || state === "cancel_requested") read.run.state = state;
    const mounted = await mountDecisions(read); if (state === "stale") mounted.update({ available: false });
    expect((screen.getByRole("button", { name: "Approve", exact: true }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Reject", exact: true }) as HTMLButtonElement).disabled).toBe(true);
    expect(mounted.post).not.toHaveBeenCalled();
  });

  it("refreshes conflicts and requires a new confirmation with the new run version", async () => {
    const read = fixture(); const post = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ code: "control_conflict" }), { status: 409 }));
    const mounted = await mountDecisions(read, post);
    mounted.refresh.mockImplementation(async () => mounted.update({ read: { ...read, run: { ...read.run, entityVersion: 4 } } }));
    approve(); confirm(); await waitFor(() => expect(mounted.refresh).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
    approve(); expect(screen.getByRole("dialog").textContent).toContain("Run version4"); confirm();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(JSON.parse(post.mock.calls[1]![1].body as string).expectedEntityVersion).toBe(4);
  });

  it("retries an unacknowledged decision with the identical envelope and key", async () => {
    const post = vi.fn().mockRejectedValueOnce(new TypeError("connection lost")).mockResolvedValueOnce(new Response(JSON.stringify(receipt)));
    await mountDecisions(fixture(), post); approve(); confirm();
    const dialog = screen.getByRole("dialog");
    await within(dialog).findByRole("button", { name: "Retry", exact: true });
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry", exact: true }));
    await waitFor(() => expect(within(dialog).getByRole("status").textContent).toBe("Requested"));
    expect(post.mock.calls[1]![1].body).toBe(post.mock.calls[0]![1].body);
  });

  it("clears browser authority after session expiry without submitting again", async () => {
    const post = vi.fn(async () => new Response(JSON.stringify({ code: "owner_session_required" }), { status: 401 }));
    await mountDecisions(fixture(), post); approve(); confirm();
    await screen.findByText("owner_session_required");
    expect((screen.getByRole("button", { name: "Send confirmed decision" }) as HTMLButtonElement).disabled).toBe(true);
    confirm(); expect(post).toHaveBeenCalledTimes(1);
  });

  it("offers only a verified read-only session for native requests", async () => {
    const read = fixture(); read.approvals[0] = { ...read.approvals[0]!, kind: "native", action: "native-tool", payload: { attemptId: "attempt" } };
    read.attempts = [{ attemptId: "attempt", runId: read.run.id, taskId: "T020", qitemId: "qitem", role: "implementer", provider: "codex", state: "running", session: "session", unknownReason: null }];
    const mounted = await mountDecisions(read);
    expect(screen.queryByRole("button", { name: "Approve", exact: true })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open session", exact: true }));
    expect(mounted.onOpenSession).toHaveBeenCalledWith(read.attempts[0]);
    mounted.update({ read: { ...read, attempts: [] } });
    expect((screen.getByRole("button", { name: "Open session", exact: true }) as HTMLButtonElement).disabled).toBe(true);
  });
});


it("reconciles a lost acknowledgement after a fresh run version and then asks again", async () => {
  const post = vi.fn().mockRejectedValueOnce(new TypeError("connection lost"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ code: "control_conflict" }), { status: 409 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(receipt)));
  const read = fixture(), mounted = await mountDecisions(read, post); approve(); confirm();
  await screen.findByRole("button", { name: "Retry", exact: true });
  mounted.update({ read: { ...read, run: { ...read.run, entityVersion: 4 } } });
  fireEvent.click(screen.getByRole("button", { name: "Close", exact: true })); approve();
  const retry = within(screen.getByRole("dialog")).getByRole("button", { name: "Retry", exact: true });
  expect((retry as HTMLButtonElement).disabled).toBe(false); fireEvent.click(retry);
  await screen.findByText("control_conflict");
  expect(post.mock.calls[1]![1].body).toBe(post.mock.calls[0]![1].body);
  fireEvent.click(screen.getByRole("button", { name: "Close", exact: true })); approve(); confirm();
  await waitFor(() => expect(post).toHaveBeenCalledTimes(3));
  const oldRequest = JSON.parse(post.mock.calls[0]![1].body), newRequest = JSON.parse(post.mock.calls[2]![1].body);
  expect(newRequest.expectedEntityVersion).toBe(4); expect(newRequest.idempotencyKey).not.toBe(oldRequest.idempotencyKey);
});

it("disables the opposite decision while acknowledgement is outstanding", async () => {
  const post = vi.fn().mockRejectedValueOnce(new TypeError("connection lost"));
  await mountDecisions(fixture(), post); approve(); confirm();
  await within(screen.getByRole("dialog")).findByRole("button", { name: "Retry", exact: true });
  fireEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
  expect((screen.getByRole("button", { name: "Reject", exact: true }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Approve", exact: true }) as HTMLButtonElement).disabled).toBe(false);
});

it("displays an observed receipt without claiming downstream execution", async () => {
  const post = vi.fn(async () => new Response(JSON.stringify({ ...receipt, status: "observed" })));
  await mountDecisions(fixture(), post); approve(); confirm();
  await waitFor(() => expect(within(screen.getByRole("dialog")).getByRole("status").textContent).toBe("Observed"));
  expect((screen.getByRole("button", { name: "Send confirmed decision" }) as HTMLButtonElement).disabled).toBe(true);
});

it("reconciles observed projections and restores focus after the trigger disappears", async () => {
  const read = fixture(), mounted = await mountDecisions(read); const trigger = approve(); confirm();
  await within(screen.getByRole("dialog")).findByText("Requested");
  mounted.update({ read: { ...read, run: { ...read.run, entityVersion: 4 }, approvals: [{ ...read.approvals[0]!, state: "approved", entityVersion: 3 }] } });
  const dialog = screen.getByRole("dialog");
  await waitFor(() => expect(within(dialog).getByRole("status").textContent).toBe("Observed"));
  expect(dialog.textContent).not.toContain("confirm the current target"); expect(trigger.isConnected).toBe(false);
  fireEvent.click(within(dialog).getByRole("button", { name: "Close", exact: true }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "Pending decisions" })));
});


it("keeps a published observed outcome when an older request later loses acknowledgement", async () => {
  let reject!: (reason: Error) => void;
  const post = vi.fn(() => new Promise<Response>((_resolve, failed) => { reject = failed; }));
  const read = fixture(), mounted = await mountDecisions(read, post); approve(); confirm();
  mounted.update({ read: { ...read, approvals: [{ ...read.approvals[0]!, state: "approved", entityVersion: 3 }] } });
  await waitFor(() => expect(within(screen.getByRole("dialog")).getByRole("status").textContent).toBe("Observed"));
  await act(async () => reject(new TypeError("connection lost")));
  expect(within(screen.getByRole("dialog")).getByRole("status").textContent).toBe("Observed");
  expect(screen.queryByRole("button", { name: "Retry", exact: true })).toBeNull();
});


it.each([false, true])("shows a competing rejection without attributing it to approval (submitted: %s)", async submitted => {
  let reject!: (reason: Error) => void;
  const post = vi.fn(() => new Promise<Response>((_resolve, failed) => { reject = failed; }));
  const read = fixture(), mounted = await mountDecisions(read, post); approve(); if (submitted) confirm();
  mounted.update({ read: { ...read, approvals: [{ ...read.approvals[0]!, state: "rejected", entityVersion: 3 }] } });
  const dialog = screen.getByRole("dialog");
  await within(dialog).findByText("A different action decided this approval.");
  expect(dialog.textContent).toContain("Rejected"); expect(within(dialog).queryByText("Observed", { exact: true })).toBeNull();
  expect(dialog.textContent).not.toContain("confirm the current target");
  if (submitted) await act(async () => reject(new TypeError("late transport error")));
  expect(dialog.textContent).toContain("Rejected"); expect(within(dialog).queryByRole("button", { name: "Retry", exact: true })).toBeNull();
});

it("does not attribute an unsent matching decision to the open dialog", async () => {
  const read = fixture(), mounted = await mountDecisions(read); approve();
  mounted.update({ read: { ...read, approvals: [{ ...read.approvals[0]!, state: "approved", entityVersion: 3 }] } });
  await within(screen.getByRole("dialog")).findByText("A different action decided this approval.");
  expect(mounted.post).not.toHaveBeenCalled();
  expect(within(screen.getByRole("dialog")).queryByText("Observed", { exact: true })).toBeNull();
});
