import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Background, BACKGROUND_MOTION_KEY, useBackgroundPreference } from "../background.js";

let reduced = false;
let hidden = false;
let query: MediaQueryList;
beforeEach(() => {
  reduced = false; hidden = false; localStorage.clear();
  query = Object.assign(new EventTarget(), { media: "(prefers-reduced-motion: reduce)" }) as MediaQueryList;
  Object.defineProperty(query, "matches", { get: () => reduced });
  vi.spyOn(window, "matchMedia").mockReturnValue(query);
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("command-center background", () => {
  it("persists motion off and keeps a still frame without starting the video", () => {
    localStorage.setItem(BACKGROUND_MOTION_KEY, "off");
    function Fixture() { const preference = useBackgroundPreference(); return <>
      <Background motion={preference.motion} /><button onClick={() => preference.setMotion(true)}>Enable</button>
    </>; }
    const view = render(<Fixture />);
    expect(view.container.querySelector("video")).toBeNull();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    fireEvent.click(view.getByText("Enable"));
    expect(localStorage.getItem(BACKGROUND_MOTION_KEY)).toBe("on");
    expect(view.container.querySelector("video")).not.toBeNull();
  });

  it("plays the muted, inline background and pauses while hidden or blurred", () => {
    const view = render(<Background />);
    const video = view.container.querySelector("video")!;
    expect(video.muted && video.loop && video.playsInline).toBe(true);
    expect(video.getAttribute("src")).toContain("shuimo-danqing-loop.mp4");
    expect(video.play).toHaveBeenCalledTimes(1);
    hidden = true; fireEvent(document, new Event("visibilitychange"));
    expect(video.pause).toHaveBeenCalledTimes(1);
    fireEvent.blur(window);
    hidden = false; fireEvent(document, new Event("visibilitychange"));
    expect(video.play).toHaveBeenCalledTimes(1);
    fireEvent.focus(window);
    expect(video.play).toHaveBeenCalledTimes(2);
    view.unmount();
    const plays = vi.mocked(video.play).mock.calls.length;
    const pauses = vi.mocked(video.pause).mock.calls.length;
    fireEvent.focus(window); fireEvent.blur(window); fireEvent(document, new Event("visibilitychange"));
    expect(video.play).toHaveBeenCalledTimes(plays);
    expect(video.pause).toHaveBeenCalledTimes(pauses);
  });

  it("uses a still frame for reduced motion and responds to preference changes", () => {
    reduced = true;
    const view = render(<Background />);
    expect(view.container.querySelector("video")).toBeNull();
    expect(view.container.querySelector("img")!.getAttribute("src")).toContain("shuimo-danqing-still.webp");
    act(() => { reduced = false; query.dispatchEvent(new Event("change")); });
    const video = view.container.querySelector("video")!;
    expect(video.play).toHaveBeenCalledTimes(1);
    act(() => { reduced = true; query.dispatchEvent(new Event("change")); });
    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector("video")).toBeNull();
  });

  it("leaves the poster visible when autoplay is rejected", async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(new Error("autoplay blocked"));
    const view = render(<Background />);
    await act(async () => {});
    expect(view.container.querySelector("video")!.poster).toContain("shuimo-danqing-still.webp");
  });
});
