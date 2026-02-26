/**
 * Demo mode utility - when enabled, all write operations are simulated
 */

export function isDemoMode(): boolean {
  const value = (process.env.DEMO_MODE || "").trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes" || value === "on";
}

export function logDemoAction(action: string, details?: Record<string, unknown>): void {
  if (isDemoMode()) {
    console.info(`[DEMO MODE] Simulated action: ${action}`, details || {});
  }
}
