import crypto from "crypto";
import fs from "fs/promises";
import {
  readLaunchpadFile,
  writeLaunchpadFile,
  type LaunchpadItem,
} from "./launchpadItems.js";
import type { DockerContainer } from "./dockerCli.js";
import type { RemoteServer } from "./remoteServers.js";
import { getLaunchpadIconsUploadsPath } from "./dashboardSettings.js";

type ServiceLink = {
  port: number;
  containerPort: number;
  protocol: "http" | "https";
  url: string;
  label: string;
};

function isContainerRunning(container: DockerContainer): boolean {
  const stateText = (container.State || "").toLowerCase();
  const statusText = (container.Status || "").toLowerCase();
  return stateText === "running" || statusText.startsWith("up");
}

function getServiceHost(server: RemoteServer): string {
  if (server.isLocal) {
    return "localhost";
  }

  const host = (server.host || "").trim();
  if (!host) {
    return "localhost";
  }

  return host.replace(/^https?:\/\//i, "");
}

function inferServiceLinksFromPorts(portsValue: string, serviceHost: string): ServiceLink[] {
  if (!portsValue.trim()) {
    return [];
  }

  const result: ServiceLink[] = [];
  const seen = new Set<string>();
  const entries = portsValue.split(",").map((entry) => entry.trim()).filter(Boolean);

  for (const entry of entries) {
    const match = entry.match(/(?:[^\s,]+:)?(?<hostPort>\d+)->(?<containerPort>\d+)\/(?<transport>[a-z]+)/i);
    if (!match?.groups) {
      continue;
    }

    const hostPort = Number.parseInt(match.groups.hostPort, 10);
    const containerPort = Number.parseInt(match.groups.containerPort, 10);
    const transport = (match.groups.transport || "").toLowerCase();

    if (!Number.isFinite(hostPort) || !Number.isFinite(containerPort) || transport !== "tcp") {
      continue;
    }

    const protocol: ServiceLink["protocol"] = hostPort === 443 || containerPort === 443 ? "https" : "http";
    const url = `${protocol}://${serviceHost}:${hostPort}`;
    if (seen.has(url)) {
      continue;
    }

    seen.add(url);
    result.push({
      port: hostPort,
      containerPort,
      protocol,
      url,
      label: `${protocol.toUpperCase()} ${hostPort}`,
    });
  }

  return result.sort((a, b) => a.port - b.port);
}

/**
 * Merges duplicate launchpad items for a server, ensuring only one item per container name.
 * Priority: running > stopped > removed, and user-customized over auto-discovered.
 * Preserves user settings from any customized duplicates.
 */
function mergeDuplicateItems(items: LaunchpadItem[], serverId: string): { items: LaunchpadItem[], hasChanges: boolean } {
  let hasChanges = false;
  
  // Group items by container name for this server
  const itemsByName = new Map<string, LaunchpadItem[]>();
  
  for (const item of items) {
    if (item.serverId !== serverId) {
      continue;
    }
    
    const existing = itemsByName.get(item.containerName);
    if (existing) {
      existing.push(item);
    } else {
      itemsByName.set(item.containerName, [item]);
    }
  }
  
  // Process each group of items with the same name
  const itemsToKeep = new Set<string>(); // Track item IDs to keep
  const itemsToDelete = new Set<string>(); // Track item IDs to delete
  
  for (const [containerName, duplicates] of itemsByName) {
    if (duplicates.length === 1) {
      // No duplicates, keep it
      itemsToKeep.add(duplicates[0].id);
      continue;
    }
    
    // Multiple items with same name - select winner and merge settings
    
    // Sort by priority: running > stopped > removed, then user-customized > auto-discovered
    const sorted = duplicates.sort((a, b) => {
      // Status priority
      const statusPriority = { running: 3, stopped: 2, removed: 1 };
      const aPriority = statusPriority[a.status] || 0;
      const bPriority = statusPriority[b.status] || 0;
      
      if (aPriority !== bPriority) {
        return bPriority - aPriority; // Higher priority first
      }
      
      // User-customized first
      if (!a.autoDiscovered && b.autoDiscovered) return -1;
      if (a.autoDiscovered && !b.autoDiscovered) return 1;
      
      // Most recent
      return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
    });
    
    const winner = sorted[0];
    const losers = sorted.slice(1);
    
    // Merge user settings from any user-customized losers
    for (const loser of losers) {
      if (!loser.autoDiscovered) {
        // Transfer user settings to winner
        winner.name = loser.name;
        winner.description = loser.description;
        winner.publicUrl = loser.publicUrl;
        winner.iconImage = loser.iconImage;
        winner.hidden = loser.hidden;
        winner.autoDiscovered = false;
        hasChanges = true;
        console.log(`[Launchpad] Merged user settings from duplicate "${loser.name}" into "${winner.containerName}"`);
      }
    }
    
    // Mark winner to keep, losers to delete
    itemsToKeep.add(winner.id);
    for (const loser of losers) {
      itemsToDelete.add(loser.id);
      hasChanges = true;
      console.log(`[Launchpad] Removed duplicate: "${loser.name}" (ID: ${loser.containerId})`);
    }
  }
  
  // Filter items: keep winners and all items from other servers
  const resultItems = items.filter(item => {
    if (item.serverId !== serverId) {
      return true; // Keep items from other servers
    }
    return itemsToKeep.has(item.id); // Only keep winners from this server
  });
  
  return { items: resultItems, hasChanges };
}

/**
 * Attempts to infer an icon image path based on container name/image matching icon filenames
 */
async function inferIconImage(container: DockerContainer): Promise<string> {
  try {
    const iconsDir = getLaunchpadIconsUploadsPath();
    const files = await fs.readdir(iconsDir);
    
    // Filter to only image files
    const iconFiles = files.filter(file => /\.(png|jpg|jpeg|svg|gif|webp)$/i.test(file));
    
    // Extract names to match against (container name and image name)
    const containerName = container.Names.toLowerCase();
    const imageName = container.Image.toLowerCase();
    
    // Try to find a matching icon file
    for (const iconFile of iconFiles) {
      // Get filename without extension
      const iconBaseName = iconFile.replace(/\.(png|jpg|jpeg|svg|gif|webp)$/i, '').toLowerCase();
      
      // Check if container name or image contains the icon base name
      if (containerName.includes(iconBaseName) || imageName.includes(iconBaseName)) {
        return `/uploads/launchpad-icons/${iconFile}`;
      }
    }
    
    return "";
  } catch (error) {
    console.error(`[Launchpad] Failed to infer icon for ${container.Names}:`, error);
    return "";
  }
}


/**
 * Syncs launchpad items for a specific server based on discovered containers
 * Returns true if changes were made, false otherwise
 */
export async function syncLaunchpadItemsForServer(
  server: RemoteServer,
  containers: DockerContainer[]
): Promise<boolean> {
  const file = await readLaunchpadFile();
  const now = new Date().toISOString();
  let hasChanges = false;

  // Map existing items for this server
  const existingMap = new Map<string, LaunchpadItem>();
  for (const item of file.items) {
    if (item.serverId === server.id) {
      existingMap.set(item.containerId, item);
    }
  }

  // Create a map of all containers by ID for quick lookup
  const containerMap = new Map<string, DockerContainer>();
  for (const container of containers) {
    containerMap.set(container.ID, container);
  }

  const serviceHost = getServiceHost(server);

  // Process ALL containers from the server
  for (const container of containers) {
    const existing = existingMap.get(container.ID);
    const isRunning = isContainerRunning(container);
    const newStatus = isRunning ? "running" : "stopped";
    const serviceLinks = inferServiceLinksFromPorts(container.Ports || "", serviceHost);
    const localUrl = serviceLinks[0]?.url || "";

    if (!existing) {
      // NEW CONTAINER: Only add if it has HTTP ports visible
      if (serviceLinks.length === 0) {
        continue;
      }

      // Create new item - duplicates will be merged later
      const inferredIcon = await inferIconImage(container);
      file.items.push({
        id: crypto.randomUUID(),
        serverId: server.id,
        containerId: container.ID,
        containerName: container.Names,
        name: container.Names,
        description: undefined,
        publicUrl: "",
        localUrl,
        iconImage: inferredIcon,
        hidden: false,
        status: newStatus,
        lastSeen: now,
        autoDiscovered: true,
      });
      hasChanges = true;
      console.log(`[Launchpad] Discovered new service: ${container.Names} on ${server.name || server.id}`);
    } else {
      // EXISTING CONTAINER: Update status and info regardless of port visibility
      let itemChanged = false;

      if (existing.status !== newStatus) {
        existing.status = newStatus;
        itemChanged = true;
      }

      if (existing.containerName !== container.Names) {
        existing.containerName = container.Names;
        itemChanged = true;
      }

      // Only update localUrl if ports are visible (preserve existing URL when stopped)
      if (localUrl && existing.localUrl !== localUrl) {
        existing.localUrl = localUrl;
        itemChanged = true;
      }

      existing.lastSeen = now;

      if (itemChanged) {
        hasChanges = true;
      }

      existingMap.delete(container.ID);
    }
  }

  // Mark remaining items as removed (they're no longer in the container list at all)
  for (const [containerId, item] of existingMap) {
    if (item.status !== "removed") {
      item.status = "removed";
      hasChanges = true;
      console.log(`[Launchpad] Marked as removed: ${item.name} on ${server.name || server.id}`);
    }
  }

  // Merge duplicate items for this server (ensures only one item per container name)
  const mergeResult = mergeDuplicateItems(file.items, server.id);
  file.items = mergeResult.items;
  if (mergeResult.hasChanges) {
    hasChanges = true;
  }

  // Update last sync time
  file.lastSyncTime = now;

  // Only write if there are actual changes
  if (hasChanges) {
    await writeLaunchpadFile(file);
    console.log(`[Launchpad] Synced ${server.name || server.id}: ${containers.length} containers processed`);
  }

  return hasChanges;
}
