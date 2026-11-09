import { useEffect, useRef, useState } from "react";

const MEDIA = "(prefers-reduced-motion: reduce)";
const ASSET = "/skins/shuimo-danqing/shuimo-danqing";
// Seek to the revealed portrait keyframe, avoiding a decode from the entrance on every loop.
const PORTRAIT_START = 250 / 24;
const PORTRAIT_END = 23;
const ENTRANCE_KEY = "openrig.shuimoDanqingEntered";
export const BACKGROUND_MOTION_KEY = "openrig.teamBackgroundMotion";

export function useBackgroundPreference() {
  const [motion, setMotion] = useState(() => {
    try { return localStorage.getItem(BACKGROUND_MOTION_KEY) !== "off"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem(BACKGROUND_MOTION_KEY, motion ? "on" : "off"); } catch { /* This load still follows the choice. */ }
  }, [motion]);
  return { motion, setMotion };
}

export function Background({ motion = true }: { motion?: boolean }) {
  const [reduced, setReduced] = useState(() => window.matchMedia(MEDIA).matches);
  const video = useRef<HTMLVideoElement>(null);
  const entered = useRef(false);
  useEffect(() => {
    const query = window.matchMedia(MEDIA);
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const element = video.current;
    if (!element || reduced || !motion) return;
    try { entered.current ||= sessionStorage.getItem(ENTRANCE_KEY) === "1"; } catch { /* Keep the in-memory phase. */ }
    let focused = document.hasFocus();
    const sync = () => {
      if (document.hidden || !focused) element.pause();
      else void element.play().catch(() => { /* Autoplay restrictions leave the poster visible. */ });
    };
    const restore = () => { if (entered.current) element.currentTime = PORTRAIT_START; };
    const started = () => {
      if (entered.current) return;
      entered.current = true;
      try { sessionStorage.setItem(ENTRANCE_KEY, "1"); } catch { /* Motion toggles still keep the phase. */ }
    };
    const repeatPortrait = () => { element.currentTime = PORTRAIT_START; sync(); };
    const advance = () => { if (element.currentTime >= PORTRAIT_END) repeatPortrait(); };
    element.addEventListener("loadedmetadata", restore);
    element.addEventListener("playing", started);
    element.addEventListener("timeupdate", advance);
    element.addEventListener("ended", repeatPortrait);
    if (element.readyState >= 1) restore();
    const blur = () => { focused = false; sync(); };
    const focus = () => { focused = true; sync(); };
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    sync();
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      element.removeEventListener("loadedmetadata", restore);
      element.removeEventListener("playing", started);
      element.removeEventListener("timeupdate", advance);
      element.removeEventListener("ended", repeatPortrait);
      element.pause();
    };
  }, [reduced, motion]);
  return <div className="team-backdrop" aria-hidden="true">
    {reduced || !motion ? <img src={`${ASSET}-still.webp`} alt="" />
      : <video ref={video} muted playsInline preload="auto" tabIndex={-1}
        poster={`${ASSET}-still.webp`} src={`${ASSET}-loop.mp4`} />}
  </div>;
}
