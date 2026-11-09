import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Background, BACKGROUND_MOTION_KEY, useBackgroundPreference } from "../background.js";

let reduced = false;
let hidden = false;
let query: MediaQueryList;
beforeEach(() => {
  reduced = false; hidden = false; localStorage.clear(); sessionStorage.clear();
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
    expect(video.muted && video.playsInline).toBe(true);
    expect(video.loop).toBe(false);
    expect(video.preload).toBe("auto");
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

  it("plays the entrance once, then repeats from the revealed portrait keyframe before the fade", () => {
    const view = render(<Background />);
    const video = view.container.querySelector("video")!;
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(0);
    fireEvent.playing(video);
    video.currentTime = 23.1;
    fireEvent.timeUpdate(video);
    expect(video.currentTime).toBe(250 / 24);
    video.currentTime = 23.1;
    fireEvent.timeUpdate(video);
    expect(video.currentTime).toBe(250 / 24);
    video.currentTime = 25.333;
    fireEvent.ended(video);
    expect(video.currentTime).toBe(250 / 24);
  });

  it("skips the entrance after navigation or a reload in the same session", () => {
    const first = render(<Background />);
    fireEvent.playing(first.container.querySelector("video")!);
    first.unmount();
    const next = render(<Background />);
    const video = next.container.querySelector("video")!;
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(250 / 24);
  });

  it("keeps the portrait phase when motion is reenabled and storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage disabled"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage disabled"); });
    const view = render(<Background />);
    fireEvent.playing(view.container.querySelector("video")!);
    view.rerender(<Background motion={false} />);
    view.rerender(<Background motion />);
    const video = view.container.querySelector("video")!;
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(250 / 24);
  });

  it("keeps playback position on focus changes and never resumes a hidden loop", () => {
    const view = render(<Background />);
    const video = view.container.querySelector("video")!;
    fireEvent.playing(video);
    video.currentTime = 14;
    fireEvent.blur(window);
    fireEvent.focus(window);
    expect(video.currentTime).toBe(14);
    hidden = true;
    fireEvent(document, new Event("visibilitychange"));
    const plays = vi.mocked(video.play).mock.calls.length;
    video.currentTime = 23.1;
    fireEvent.timeUpdate(video);
    expect(video.currentTime).toBe(250 / 24);
    expect(video.play).toHaveBeenCalledTimes(plays);
  });

  it("starts a fresh entrance in a new session", () => {
    const first = render(<Background />);
    fireEvent.playing(first.container.querySelector("video")!);
    first.unmount();
    sessionStorage.clear();
    const next = render(<Background />);
    const video = next.container.querySelector("video")!;
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(0);
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
    expect(sessionStorage.length).toBe(0);
  });
});
