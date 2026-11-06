import { useEffect, useRef, useState } from "react";

const MEDIA = "(prefers-reduced-motion: reduce)";
const ASSET = "/skins/shuimo-danqing/shuimo-danqing";

export function Background() {
  const [reduced, setReduced] = useState(() => window.matchMedia(MEDIA).matches);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const query = window.matchMedia(MEDIA);
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const element = video.current;
    if (!element || reduced) return;
    let focused = document.hasFocus();
    const sync = () => {
      if (document.hidden || !focused) element.pause();
      else void element.play().catch(() => { /* Autoplay restrictions leave the poster visible. */ });
    };
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
      element.pause();
    };
  }, [reduced]);
  return <div className="team-backdrop" aria-hidden="true">
    {reduced ? <img src={`${ASSET}-still.webp`} alt="" />
      : <video ref={video} muted loop playsInline preload="metadata" tabIndex={-1}
        poster={`${ASSET}-still.webp`} src={`${ASSET}-loop.mp4`} />}
  </div>;
}
