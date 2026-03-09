import type {
  DockerContainer,
  DockerContainerStat,
  DockerHostInfo,
  DockerTargetServer,
} from "./dockerCli.js";
import { getDashboardSettings } from "./dashboardSettings.js";

// Cache TTL matches the dashboard refresh interval
async function getCacheTTL(): Promise<number> {
  const settings = await getDashboardSettings();
  return settings.dashboardRefreshInterval;
}

type DockerDataSnapshot = {
  containers: DockerContainer[];
  stats: DockerContainerStat[];
  hostInfo: DockerHostInfo | null;
  timestamp: number;
  isRefreshing: boolean;
};

type FetchDockerDataFn = () => Promise<{
  containers: DockerContainer[];
  stats: DockerContainerStat[];
  hostInfo: DockerHostInfo | null;
}>;

const cache = new Map<string, DockerDataSnapshot>();

function getServerCacheKey(server: DockerTargetServer): string {
  if (server.isLocal) {
    return "local";
  }
  // Create a unique key based on host and username for remote servers
  return `${server.host}::${server.username}`;
}

async function isCacheValid(snapshot: DockerDataSnapshot): Promise<boolean> {
  const age = Date.now() - snapshot.timestamp;
  const ttl = await getCacheTTL();
  return age < ttl;
}

async function refreshCacheInBackground(
  cacheKey: string,
  fetchFn: FetchDockerDataFn
): Promise<void> {
  const existing = cache.get(cacheKey);
  if (!existing || existing.isRefreshing) {
    return;
  }

  // Mark as refreshing to prevent duplicate refreshes
  existing.isRefreshing = true;

  try {
    const freshData = await fetchFn();
    cache.set(cacheKey, {
      containers: freshData.containers,
      stats: freshData.stats,
      hostInfo: freshData.hostInfo,
      timestamp: Date.now(),
      isRefreshing: false,
    });
  } catch (error) {
    // On error, keep the stale cache but mark as not refreshing
    existing.isRefreshing = false;
    console.warn(`Background cache refresh failed for ${cacheKey}:`, (error as Error).message);
  }
}

/**
 * Gets Docker data from cache or fetches fresh data if cache is invalid or missing.
 * If cache exists but is stale, returns cached data immediately and refreshes in background.
 */
export async function getCachedDockerData(
  server: DockerTargetServer,
  fetchFn: FetchDockerDataFn
): Promise<{
  containers: DockerContainer[];
  stats: DockerContainerStat[];
  hostInfo: DockerHostInfo | null;
  cacheAge: number;
}> {
  const cacheKey = getServerCacheKey(server);
  const cached = cache.get(cacheKey);

  // Cache miss - fetch fresh data
  if (!cached) {
    const freshData = await fetchFn();
    cache.set(cacheKey, {
      containers: freshData.containers,
      stats: freshData.stats,
      hostInfo: freshData.hostInfo,
      timestamp: Date.now(),
      isRefreshing: false,
    });

    return {
      ...freshData,
      cacheAge: 0,
    };
  }

  // Cache hit and still valid - return immediately
  if (await isCacheValid(cached)) {
    return {
      containers: cached.containers,
      stats: cached.stats,
      hostInfo: cached.hostInfo,
      cacheAge: Date.now() - cached.timestamp,
    };
  }

  // Cache hit but stale - return stale data and refresh in background
  void refreshCacheInBackground(cacheKey, fetchFn);

  return {
    containers: cached.containers,
    stats: cached.stats,
    hostInfo: cached.hostInfo,
    cacheAge: Date.now() - cached.timestamp,
  };
}

/**
 * Invalidates the cache for a specific server or all servers
 */
export function invalidateCache(server?: DockerTargetServer): void {
  if (server) {
    const cacheKey = getServerCacheKey(server);
    cache.delete(cacheKey);
  } else {
    cache.clear();
  }
}

/**
 * Gets cache statistics for monitoring
 */
export function getCacheStats(): {
  totalEntries: number;
  entries: Array<{ server: string; age: number; isRefreshing: boolean }>;
} {
  const entries: Array<{ server: string; age: number; isRefreshing: boolean }> = [];

  for (const [key, snapshot] of cache.entries()) {
    entries.push({
      server: key,
      age: Date.now() - snapshot.timestamp,
      isRefreshing: snapshot.isRefreshing,
    });
  }

  return {
    totalEntries: cache.size,
    entries,
  };
}
