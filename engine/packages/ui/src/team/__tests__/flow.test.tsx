import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createInterfaceI18n, type InterfaceLanguage } from "@openrig/i18n";
import { I18nextProvider } from "react-i18next";
import type { i18n as I18n } from "i18next";
import { FlowView } from "../flow/FlowView.js";
import { HIGH_DENSITY_EVENTS, HIGH_DENSITY_SEATS, LOW_DENSITY_EVENTS, FLOW_FIXTURE_SEATS } from "../flow/fixtures.js";
import { mapTeamEvents } from "../flow/flow-events.js";
import { FlowRenderer } from "../flow/flow-renderer.js";

function contextStub(): CanvasRenderingContext2D {
  const noop = () => {};
  return {
    canvas: document.createElement("canvas"),
    clearRect: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, quadraticCurveTo: noop,
    arc: noop, fill: noop, stroke: noop, save: noop, restore: noop, fillText: noop, setLineDash: noop,
    measureText: () => ({ width: 20 } as TextMetrics),
    setTransform: noop,
    globalAlpha: 1, lineWidth: 1, shadowBlur: 0, shadowColor: "", strokeStyle: "", fillStyle: "",
  } as unknown as CanvasRenderingContext2D;
}

const languages = new Map<InterfaceLanguage, I18n>();
const show = (language: InterfaceLanguage = "en") => render(<I18nextProvider i18n={languages.get(language)!}>
  <FlowView events={LOW_DENSITY_EVENTS} seats={FLOW_FIXTURE_SEATS} />
</I18nextProvider>);

beforeAll(async () => {
  for (const language of ["en", "zh-CN"] as const) languages.set(language, (await createInterfaceI18n({ language })).instance);
});

describe("FlowView", () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancelRaf = globalThis.cancelAnimationFrame;
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: vi.fn(() => contextStub()) });
  });

  afterEach(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: originalGetContext });
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: originalRaf });
    Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: originalCancelRaf });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
  });

  it("renders accessible names and supports keyboard node selection", () => {
    show();
    const worker = screen.getByRole("button", { name: /Worker 1, implementer/i });
    fireEvent.keyDown(worker, { key: "Enter" });
    expect(worker.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("status", { name: /Selected Worker 1/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Lead, lead/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Reviewer, reviewer/i })).toBeTruthy();
  });

  it("pauses and resumes the frame loop", () => {
    let next = 0;
    const callbacks = new Map<number, FrameRequestCallback>();
    const raf = vi.fn((callback: FrameRequestCallback) => {
      const id = ++next;
      callbacks.set(id, callback);
      return id;
    });
    const cancel = vi.fn((id: number) => callbacks.delete(id));
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: raf });
    Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: cancel });
    show();
    expect(raf).toHaveBeenCalled();
    const callsBeforePause = raf.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(cancel).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Resume" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(raf.mock.calls.length).toBeGreaterThan(callsBeforePause);
  });

  it("pauses on window blur and restarts on focus", () => {
    let next = 0;
    const callbacks = new Map<number, FrameRequestCallback>();
    const raf = vi.fn((callback: FrameRequestCallback) => {
      const id = ++next;
      callbacks.set(id, callback);
      return id;
    });
    const cancel = vi.fn((id: number) => callbacks.delete(id));
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: raf });
    Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: cancel });
    show();
    const callsBeforeBlur = raf.mock.calls.length;
    fireEvent(window, new Event("blur"));
    expect(cancel).toHaveBeenCalled();
    fireEvent(window, new Event("focus"));
    expect(raf.mock.calls.length).toBeGreaterThan(callsBeforeBlur);
  });

  it("renders the static event list for reduced motion", () => {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
    show();
    expect(screen.getByText(/Motion is reduced/i)).toBeTruthy();
    expect(screen.getByLabelText("Flow event list")).toBeTruthy();
    expect(screen.getAllByText("task assigned", { exact: false }).length).toBeGreaterThan(0);
  });

  it("renders its controls and states from the active interface language", () => {
    show("zh-CN");
    expect(screen.getByRole("button", { name: "暂停" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "团队席位" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /负责人，负责人/ })).toBeTruthy();
  });

  it("falls back to the static event list when Canvas2D is unavailable", () => {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: vi.fn(() => null) });
    show();
    expect(screen.getByText(/Canvas2D is unavailable/i)).toBeTruthy();
    expect(screen.getByLabelText("Flow event list")).toBeTruthy();
  });
});

describe("FlowRenderer", () => {
  it("draws the high-density fixture within a generous frame budget", () => {
    const canvas = document.createElement("canvas");
    const renderer = new FlowRenderer({ canvas, maxParticles: 96 });
    const mapping = mapTeamEvents(HIGH_DENSITY_EVENTS, { seats: HIGH_DENSITY_SEATS, maxParticles: 96 });
    renderer.resize(960, 640);
    renderer.setModel(mapping);
    const start = performance.now();
    renderer.draw(contextStub(), Date.now());
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(250);
  });
});
