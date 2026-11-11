import type { DaemonClient } from "./client.js";
import type { LifecycleDeps } from "./daemon-lifecycle.js";

export interface StatusDeps {
  lifecycleDeps: LifecycleDeps;
  clientFactory: (baseUrl: string) => DaemonClient;
}
