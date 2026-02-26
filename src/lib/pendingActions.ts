/**
 * Pending Actions Manager
 * Tracks container actions that are in progress to provide immediate UI feedback
 * while waiting for the cache to update with actual container states.
 */

export type PendingActionType = "starting" | "stopping" | "restarting" | "removing";

type PendingAction = {
  action: PendingActionType;
  timestamp: number;
  serverId: string;
};

// Store pending actions: key = "serverId::containerId"
const pendingActions = new Map<string, PendingAction>();

// Auto-expire pending actions after 15 seconds
const PENDING_ACTION_TTL_MS = 15_000;

function getPendingKey(serverId: string, containerId: string): string {
  return `${serverId}::${containerId}`;
}

/**
 * Records that a container action is in progress
 */
export function setPendingAction(
  serverId: string,
  containerId: string,
  action: PendingActionType
): void {
  const key = getPendingKey(serverId, containerId);
  pendingActions.set(key, {
    action,
    timestamp: Date.now(),
    serverId,
  });
}

/**
 * Gets the pending action for a container, if any
 * Returns null if no pending action or if the action has expired
 */
export function getPendingAction(
  serverId: string,
  containerId: string
): PendingAction | null {
  const key = getPendingKey(serverId, containerId);
  const pending = pendingActions.get(key);

  if (!pending) {
    return null;
  }

  // Check if expired
  const age = Date.now() - pending.timestamp;
  if (age > PENDING_ACTION_TTL_MS) {
    pendingActions.delete(key);
    return null;
  }

  return pending;
}

/**
 * Manually clears a pending action for a container
 */
export function clearPendingAction(serverId: string, containerId: string): void {
  const key = getPendingKey(serverId, containerId);
  pendingActions.delete(key);
}

/**
 * Gets all pending actions for a specific server
 */
export function getPendingActionsForServer(
  serverId: string
): Map<string, PendingAction> {
  const result = new Map<string, PendingAction>();

  for (const [key, pending] of pendingActions.entries()) {
    if (pending.serverId !== serverId) {
      continue;
    }

    // Check if expired
    const age = Date.now() - pending.timestamp;
    if (age > PENDING_ACTION_TTL_MS) {
      pendingActions.delete(key);
      continue;
    }

    // Extract container ID from key
    const containerId = key.split("::").slice(1).join("::");
    result.set(containerId, pending);
  }

  return result;
}

/**
 * Clears all expired pending actions
 */
export function cleanupExpiredPendingActions(): void {
  const now = Date.now();

  for (const [key, pending] of pendingActions.entries()) {
    const age = now - pending.timestamp;
    if (age > PENDING_ACTION_TTL_MS) {
      pendingActions.delete(key);
    }
  }
}

/**
 * Clears all pending actions (useful for testing)
 */
export function clearAllPendingActions(): void {
  pendingActions.clear();
}

/**
 * Gets statistics about pending actions
 */
export function getPendingActionsStats(): {
  totalPending: number;
  byAction: Record<PendingActionType, number>;
} {
  cleanupExpiredPendingActions();

  const stats = {
    totalPending: pendingActions.size,
    byAction: {
      starting: 0,
      stopping: 0,
      restarting: 0,
      removing: 0,
    } as Record<PendingActionType, number>,
  };

  for (const pending of pendingActions.values()) {
    stats.byAction[pending.action] = (stats.byAction[pending.action] || 0) + 1;
  }

  return stats;
}
