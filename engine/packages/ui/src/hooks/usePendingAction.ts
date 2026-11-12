import { useEffect, useRef, useState } from "react";

/** Keep an accepted action disabled until a server projection changes its revision. */
export function usePendingAction(revision: string | number | undefined) {
  const current = useRef(revision);
  current.current = revision;
  const pending = useRef(false), submitted = useRef(revision), inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const release = () => { pending.current = false; setBusy(false); };
  useEffect(() => {
    if (!inFlight.current && current.current !== submitted.current) release();
  }, [revision]);
  return {
    busy,
    begin() {
      if (pending.current) return false;
      pending.current = true; inFlight.current = true; submitted.current = current.current; setBusy(true);
      return true;
    },
    complete() {
      inFlight.current = false;
      if (current.current !== submitted.current) release();
    },
    fail() { inFlight.current = false; release(); },
  };
}
