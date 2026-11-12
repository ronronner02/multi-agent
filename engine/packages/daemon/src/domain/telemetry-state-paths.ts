import { join } from "node:path";

export function contextUsageDirectory(multiAgentHome: string): string {
  return join(multiAgentHome, "state", "context-usage");
}

export function legacyContextUsageDirectory(multiAgentHome: string): string {
  return join(multiAgentHome, "context");
}

export function providerUsageDirectory(multiAgentHome: string): string {
  return join(multiAgentHome, "state", "provider-usage");
}

export function legacyProviderUsageDirectory(multiAgentHome: string): string {
  return join(multiAgentHome, "provider-usage");
}

export function telemetrySidecarFilename(sessionName: string): string {
  return `${sessionName.replace(/[^a-zA-Z0-9@._-]/g, "_")}.json`;
}

export function telemetrySidecarPath(directory: string, sessionName: string): string {
  return join(directory, telemetrySidecarFilename(sessionName));
}
