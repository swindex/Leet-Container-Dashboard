import crypto from "crypto";
import {
  readLaunchpadFile,
  writeLaunchpadFile,
  type LaunchpadItem,
} from "./launchpadItems.js";
import type { DockerContainer } from "./dockerCli.js";
import type { RemoteServer } from "./remoteServers.js";

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

function inferLauncherIcon(container: DockerContainer): { iconClass: string; iconColorClass: string } {
  const candidate = `${container.Names} ${container.Image}`.toLowerCase();
  const knownApps: Array<{ match: RegExp; iconClass: string; iconColorClass: string }> = [
    { match: /emby/, iconClass: "fa-solid fa-play", iconColorClass: "launcher-icon-emby" },
    { match: /immich/, iconClass: "fa-solid fa-images", iconColorClass: "launcher-icon-immich" },
    { match: /plex/, iconClass: "fa-solid fa-circle-play", iconColorClass: "launcher-icon-plex" },
    { match: /jellyfin/, iconClass: "fa-solid fa-clapperboard", iconColorClass: "launcher-icon-jellyfin" },
    { match: /grafana/, iconClass: "fa-solid fa-chart-column", iconColorClass: "launcher-icon-grafana" },
    { match: /portainer/, iconClass: "fa-solid fa-cubes", iconColorClass: "launcher-icon-portainer" },
    { match: /nextcloud/, iconClass: "fa-solid fa-cloud", iconColorClass: "launcher-icon-nextcloud" },
  ];

  for (const app of knownApps) {
    if (app.match.test(candidate)) {
      return {
        iconClass: app.iconClass,
        iconColorClass: app.iconColorClass,
      };
    }
  }

  return {
    iconClass: "fa-solid fa-rocket",
    iconColorClass: "launcher-icon-default",
  };
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

      const iconPreset = inferLauncherIcon(container);
      file.items.push({
        id: crypto.randomUUID(),
        serverId: server.id,
        containerId: container.ID,
        containerName: container.Names,
        name: container.Names,
        description: undefined,
        publicUrl: "",
        localUrl,
        icon: iconPreset.iconClass,
        iconColor: iconPreset.iconColorClass,
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

  // Update last sync time
  file.lastSyncTime = now;

  // Only write if there are actual changes
  if (hasChanges) {
    await writeLaunchpadFile(file);
    console.log(`[Launchpad] Synced ${server.name || server.id}: ${containers.length} containers processed`);
  }

  return hasChanges;
}
