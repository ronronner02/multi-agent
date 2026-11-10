import type { Context, Next } from "hono";
import { getSelfHostId, resolvesToLocalHost } from "../domain/host-identity/fanout-contract.js";

const MH3_BOUNDARY_MESSAGE =
  "acting on a remote host is the MH-3 routing lane; the MH-2 read-through forwards allowlisted GET reads only";

export async function requireLocalTarget(c: Context, next: Next) {
  const hostParam = c.req.query("host");
  if (hostParam === undefined || resolvesToLocalHost(hostParam, getSelfHostId())) {
    return next();
  }
  const hostId = hostParam;
  const path = c.req.path;
  if (c.req.method !== "GET") {
    return c.json(
      { error: "cross_host_write_refused", boundary: "MH-3", hostId, method: c.req.method, path, message: MH3_BOUNDARY_MESSAGE },
      405,
    );
  }
  return c.json(
    { error: "read_through_path_not_allowed", boundary: "MH-3", hostId, path, message: MH3_BOUNDARY_MESSAGE },
    403,
  );
}
