// 51-09 increment 2 — self-host resolution convention (local leg).
//
// The daemon's minted self-host id (increment 1) must resolve HOME exactly like
// the "local" positional sentinel, WITHOUT overloading it: selfId and 'local'
// are two DISTINCT accepted spellings that route to the same place. This is the
// convention the queue-destination validator (increment 4) consumes so a
// destination qualified with THIS host's own id validates locally instead of
// failing as unknown_destination_rig (the E1 / 389ec01d class).
//
// NOTE: the registry-alignment assert-on-boot (plan increment 2 leg b) is NOT
// implemented here — see the driver report: the hosts registry has no self-row
// marking to compare against (routed to arch, no registry migration per fence).

import { describe, it, expect, afterEach } from "vitest";
import {
  LOCAL_HOST_ID,
  getSelfHostId,
  setSelfHostId,
  resolvesToLocalHost,
} from "../src/domain/host-identity/fanout-contract.js";

afterEach(() => setSelfHostId(null)); // reset the boot-populated module accessor between tests

describe("51-09 increment 2 — self-host local resolution", () => {
  it("resolvesToLocalHost: absent, empty, the 'local' sentinel, and the self-id all route home", () => {
    const selfId = "mars-01";
    expect(resolvesToLocalHost(undefined, selfId)).toBe(true);
    expect(resolvesToLocalHost("", selfId)).toBe(true);
    expect(resolvesToLocalHost(LOCAL_HOST_ID, selfId)).toBe(true); // 'local'
    expect(resolvesToLocalHost(selfId, selfId)).toBe(true);        // the self-id
  });

  it("the self-id is a DISTINCT spelling from the 'local' sentinel (not overloaded)", () => {
    expect("mars-01").not.toBe(LOCAL_HOST_ID);
    // both route home, but they are different tokens — selfId does not BECOME 'local'
    expect(resolvesToLocalHost("mars-01", "mars-01")).toBe(true);
    expect(resolvesToLocalHost(LOCAL_HOST_ID, "mars-01")).toBe(true);
  });

  it("a different host, and the self-id under a different case, do NOT route home", () => {
    expect(resolvesToLocalHost("vps-a", "mars-01")).toBe(false);
    expect(resolvesToLocalHost("Mars-01", "mars-01")).toBe(false); // case-SENSITIVE (matches incr-1 candidate-vs-stored)
  });

  it("with no self-id resolved yet, only absent/empty/'local' are home (self-id null is not a wildcard)", () => {
    expect(resolvesToLocalHost(undefined, null)).toBe(true);
    expect(resolvesToLocalHost(LOCAL_HOST_ID, null)).toBe(true);
    expect(resolvesToLocalHost("mars-01", null)).toBe(false);
  });

  it("getSelfHostId round-trips what boot set", () => {
    expect(getSelfHostId()).toBeNull();
    setSelfHostId("mars-01");
    expect(getSelfHostId()).toBe("mars-01");
  });
});
