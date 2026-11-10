import type { QueueItem } from "../queue-repository.js";

export interface OperatorDeliveryEngine {
  dispatchEscalation: (
    row: QueueItem,
    reason: string,
  ) => Promise<{ decision: string; resolved: boolean; notificationKey?: string; dispatched?: boolean; decisionId?: string }>;
}

