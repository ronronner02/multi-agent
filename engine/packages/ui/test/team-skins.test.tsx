import React from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applySkin, readStoredSkin, SKIN_STORAGE_KEY, writeStoredSkin } from "../src/lib/theme.js";

describe("managed skin selection", () => {
  beforeEach(() => { localStorage.clear(); delete document.documentElement.dataset.skin; });
  it("defaults to the navy benchmark", () => {
    expect(readStoredSkin()).toBe("navy");
  });
  it("persists only the selection without changing theme or page state", () => {
    document.documentElement.className = "dark";
    writeStoredSkin("shuimo-danqing");
    applySkin(readStoredSkin());
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem(SKIN_STORAGE_KEY)).toBe("shuimo-danqing");
    expect(document.documentElement.dataset.skin).toBe("shuimo-danqing");
    expect(document.documentElement.className).toBe("dark");
    applySkin("navy");
    expect(document.documentElement.dataset.skin).toBeUndefined();
  });
  it("ignores an unrecognized stored skin", () => {
    localStorage.setItem(SKIN_STORAGE_KEY, "other");
    expect(readStoredSkin()).toBe("navy");
  });
});


import { SkinBackdrop } from "../src/team/shell.js";

describe("decorative skin motion", () => {
  let reduced: boolean;
  let listeners: Array<() => void>;
  let play: ReturnType<typeof vi.spyOn>;
  let pause: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    reduced = false; listeners = [];
    vi.stubGlobal("matchMedia", () => ({ get matches() { return reduced; },
      addEventListener(_name: string, callback: () => void) { listeners.push(callback); },
      removeEventListener(_name: string, callback: () => void) { listeners = listeners.filter(item => item !== callback); },
    }));
    play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it("uses static, muted, noninteractive media rather than a bundled or focusable video", () => {
    const { container } = render(<SkinBackdrop skin="shuimo-danqing" />);
    const video = container.querySelector("video")!;
    expect(video.getAttribute("src")).toBe("/skins/shuimo-danqing/shuimo-danqing-loop.mp4");
    expect(video.muted).toBe(true);
    expect(video.controls).toBe(false);
    expect(video.parentElement?.getAttribute("aria-hidden")).toBe("true");
    expect(play).toHaveBeenCalled();
  });
  it("starts paused when reduced motion is already requested", () => {
    reduced = true; render(<SkinBackdrop skin="shuimo-danqing" />);
    expect(pause).toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });
  it("pauses the existing video when reduced motion changes", () => {
    render(<SkinBackdrop skin="shuimo-danqing" />);
    act(() => { reduced = true; listeners.forEach(listener => listener()); });
    expect(pause).toHaveBeenCalled();
  });
  it("does not create media for the navy benchmark and removes media when returning to it", () => {
    const { container, rerender } = render(<SkinBackdrop skin="navy" />);
    expect(container.querySelector("video")).toBeNull();
    rerender(<SkinBackdrop skin="shuimo-danqing" />);
    expect(container.querySelector("video")).toBeTruthy();
    rerender(<SkinBackdrop skin="navy" />);
    expect(container.querySelector("video")).toBeNull();
  });
});
