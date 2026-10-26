/**
 * Maps node status to Tailwind background color class.
 */
export function getStatusColorClass(status: string | null): string {
  switch (status) {
    case "running":
      return "bg-success";
    case "idle":
      return "bg-foreground-muted";
    case "exited":
      return "bg-destructive";
    case "detached":
      return "bg-warning";
    case "unknown":
    default:
      return "bg-foreground-muted/50";
  }
}

export function getHealthStatusClass(state: string): string {
  switch (state) {
    case "ok": return "team-health-ok";
    case "degraded": return "team-health-degraded";
    case "failed": return "team-health-failed";
    default: return "team-health-unknown";
  }
}
