import type {
  DockerContainer,
  DockerContainerStat,
  DockerHostInfo,
  DockerTargetServer,
} from "./dockerCli.js";

export type DashboardContainerGroup = {
  key: string;
  title: string;
  detail: string;
  containers: DashboardContainer[];
  serviceLinks: ServiceLink[];
};

export type ServiceLink = {
  port: number;
  containerPort: number;
  protocol: "http" | "https";
  url: string;
  label: string;
};

export type DashboardContainer = DockerContainer & {
  serviceLinks: ServiceLink[];
  resourceCpu: string;
  resourceMemory: string;
  resourceNetIo: string;
  resourceBlockIo: string;
};

export type DashboardServerMetrics = {
  cpuCores: string;
  totalMemory: string;
  usedMemory: string;
  memoryUtilization: string;
  monitoredContainers: number;
  available: boolean;
  warning: string;
};

export type LaunchpadTile = {
  id: string;
  name: string;
  description: string;
  iconClass: string;
  iconColorClass: string;
  launchUrl: string;
  localUrl: string;
  publicUrl: string;
  hidden: boolean;
};

type ResolvedComposeGroup = {
  key: string;
  title: string;
  detail: string;
};

export function normalizeContainerIdentifier(identifier: string): string {
  return (identifier || "").trim().toLowerCase();
}

export function parseHumanSizeToBytes(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(/^(?<amount>\d+(?:\.\d+)?)\s*(?<unit>[kmgtp]?i?b)$/i);
  if (!match?.groups) {
    return null;
  }

  const amount = Number.parseFloat(match.groups.amount);
  if (!Number.isFinite(amount)) {
    return null;
  }

  const unit = match.groups.unit.toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1_000,
    MB: 1_000 ** 2,
    GB: 1_000 ** 3,
    TB: 1_000 ** 4,
    PB: 1_000 ** 5,
    KIB: 1_024,
    MIB: 1_024 ** 2,
    GIB: 1_024 ** 3,
    TIB: 1_024 ** 4,
    PIB: 1_024 ** 5,
  };

  const multiplier = multipliers[unit];
  if (!multiplier) {
    return null;
  }

  return amount * multiplier;
}

export function parseUsedMemoryFromMemUsage(memUsage: string): number | null {
  const usedSegment = (memUsage || "").split("/")[0]?.trim() || "";
  return parseHumanSizeToBytes(usedSegment);
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return "-";
  }

  if (value < 1024) {
    return `${Math.round(value)} B`;
  }

  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let unitIndex = -1;
  let normalized = value;

  do {
    normalized /= 1024;
    unitIndex += 1;
  } while (normalized >= 1024 && unitIndex < units.length - 1);

  return `${normalized.toFixed(normalized >= 100 ? 0 : normalized >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

export function buildContainerStatsLookup(stats: DockerContainerStat[]): Map<string, DockerContainerStat> {
  const lookup = new Map<string, DockerContainerStat>();

  for (const stat of stats) {
    const candidates = [
      stat.Name,
      stat.Container,
      stat.ID,
      (stat.ID || "").slice(0, 12),
    ];

    for (const candidate of candidates) {
      const normalized = normalizeContainerIdentifier(candidate);
      if (normalized) {
        lookup.set(normalized, stat);
      }
    }
  }

  return lookup;
}

export function resolveContainerStat(container: DockerContainer, statsLookup: Map<string, DockerContainerStat>): DockerContainerStat | null {
  const candidates = [
    container.Names,
    container.ID,
    (container.ID || "").slice(0, 12),
  ];

  for (const candidate of candidates) {
    const normalized = normalizeContainerIdentifier(candidate);
    if (!normalized) {
      continue;
    }

    const stat = statsLookup.get(normalized);
    if (stat) {
      return stat;
    }
  }

  return null;
}

export function createUnavailableServerMetrics(warning: string): DashboardServerMetrics {
  return {
    cpuCores: "-",
    totalMemory: "-",
    usedMemory: "-",
    memoryUtilization: "-",
    monitoredContainers: 0,
    available: false,
    warning,
  };
}

export function isLocalDockerUnavailableError(error: unknown): boolean {
  const message = (error as Error | undefined)?.message?.toLowerCase() ?? "";
  if (!message) {
    return false;
  }

  return (
    message.includes("cannot connect to the docker daemon") ||
    message.includes("dockerdesktoplinuxengine") ||
    message.includes("error during connect") ||
    message.includes("the system cannot find the file specified")
  );
}

export function buildServerMetrics(hostInfo: DockerHostInfo | null, stats: DockerContainerStat[], warning: string): DashboardServerMetrics {
  if (!hostInfo && !stats.length) {
    return createUnavailableServerMetrics(warning);
  }

  const totalMemoryBytes = Number.isFinite(hostInfo?.MemTotal) ? Number(hostInfo?.MemTotal) : null;
  const usedMemoryBytes = stats.reduce((sum, stat) => {
    const used = parseUsedMemoryFromMemUsage(stat.MemUsage || "");
    return sum + (used ?? 0);
  }, 0);

  const monitoredContainers = stats.length;
  const memoryUtilization = totalMemoryBytes && totalMemoryBytes > 0
    ? `${((usedMemoryBytes / totalMemoryBytes) * 100).toFixed(1)}%`
    : "-";

  return {
    cpuCores: Number.isFinite(hostInfo?.NCPU) ? String(hostInfo?.NCPU) : "-",
    totalMemory: totalMemoryBytes ? formatBytes(totalMemoryBytes) : "-",
    usedMemory: monitoredContainers ? formatBytes(usedMemoryBytes) : "-",
    memoryUtilization,
    monitoredContainers,
    available: monitoredContainers > 0 || Boolean(totalMemoryBytes) || Number.isFinite(hostInfo?.NCPU),
    warning,
  };
}

export function toBooleanFormValue(value: unknown, defaultValue = false): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => toBooleanFormValue(item, false));
  }

  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  return value === true || value === "true" || value === "on" || value === "1";
}

export function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") {
    return [value];
  }
  return [];
}

export function getSelectedContainerIdsFromBody(body: unknown): string[] {
  const bodyRecord = (body && typeof body === "object") ? (body as Record<string, unknown>) : {};

  return [
    ...toStringArray(bodyRecord.containers),
    ...toStringArray(bodyRecord["containers[]"]),
  ]
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index);
}

export function isContainerRunning(container: DockerContainer): boolean {
  const stateText = (container.State || "").toLowerCase();
  const statusText = (container.Status || "").toLowerCase();
  return stateText === "running" || statusText.startsWith("up");
}

export function containerMatchesIdentifier(container: DockerContainer, identifier: string): boolean {
  const normalized = identifier.trim();
  if (!normalized) {
    return false;
  }

  return (
    container.Names === normalized ||
    container.ID === normalized ||
    container.ID.startsWith(normalized)
  );
}

export function parseDockerLabels(labels: string): Record<string, string> {
  if (!labels) {
    return {};
  }

  return labels.split(",").reduce<Record<string, string>>((acc, pair) => {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex <= 0) {
      return acc;
    }

    const key = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    if (key) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

export function parseTruthyLabelValue(value: string | undefined): boolean {
  const normalized = (value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function normalizeUrlCandidate(value: string | undefined): string {
  const trimmed = (value || "").trim();
  if (!trimmed) {
    return "";
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed}`;
}

export function inferLaunchpadIcon(container: DockerContainer): { iconClass: string; iconColorClass: string } {
  const candidate = `${container.Names} ${container.Image}`.toLowerCase();
  const knownApps: Array<{ match: RegExp; iconClass: string; iconColorClass: string }> = [
    { match: /emby/, iconClass: "fa-solid fa-play", iconColorClass: "launchpad-icon-emby" },
    { match: /immich/, iconClass: "fa-solid fa-images", iconColorClass: "launchpad-icon-immich" },
    { match: /plex/, iconClass: "fa-solid fa-circle-play", iconColorClass: "launchpad-icon-plex" },
    { match: /jellyfin/, iconClass: "fa-solid fa-clapperboard", iconColorClass: "launchpad-icon-jellyfin" },
    { match: /grafana/, iconClass: "fa-solid fa-chart-column", iconColorClass: "launchpad-icon-grafana" },
    { match: /portainer/, iconClass: "fa-solid fa-cubes", iconColorClass: "launchpad-icon-portainer" },
    { match: /nextcloud/, iconClass: "fa-solid fa-cloud", iconColorClass: "launchpad-icon-nextcloud" },
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
    iconColorClass: "launchpad-icon-default",
  };
}

export function buildLaunchpadTiles(containers: DockerContainer[], serviceHost: string): LaunchpadTile[] {
  const tiles: LaunchpadTile[] = [];

  for (const container of containers) {
    const serviceLinks = inferServiceLinksFromPorts(container.Ports || "", serviceHost);
    if (!serviceLinks.length) {
      continue;
    }

    const localUrl = serviceLinks[0]?.url || "";
    if (!localUrl) {
      continue;
    }

    const iconPreset = inferLaunchpadIcon(container);

    tiles.push({
      id: container.ID,
      name: container.Names,
      description: container.Image,
      iconClass: iconPreset.iconClass,
      iconColorClass: iconPreset.iconColorClass,
      launchUrl: localUrl,
      localUrl,
      publicUrl: "",
      hidden: false,
    });
  }

  return tiles.sort((a, b) => a.name.localeCompare(b.name));
}

function getBaseNameFromPath(pathValue: string): string {
  const trimmed = pathValue.trim();
  if (!trimmed) {
    return "";
  }

  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || trimmed;
}

function resolveComposeGroup(container: DockerContainer): ResolvedComposeGroup {
  const labels = parseDockerLabels(container.Labels || "");
  const projectName = (labels["com.docker.compose.project"] || "").trim();
  const workingDir = (labels["com.docker.compose.project.working_dir"] || "").trim();
  const configFiles = (labels["com.docker.compose.project.config_files"] || "")
    .split(",")
    .map((item) => item.trim())
    .find(Boolean);

  const configFilesList = (labels["com.docker.compose.project.config_files"] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const configFilesDisplay = configFilesList
    .map((filePath) => getBaseNameFromPath(filePath))
    .filter(Boolean)
    .join(", ");

  if (projectName) {
    return {
      key: `project:${projectName}`,
      title: projectName,
      detail: configFilesDisplay,
    };
  }

  if (workingDir || configFilesList.length) {
    const key = `compose:${workingDir}::${configFilesList.join("|")}`;
    const title = getBaseNameFromPath(workingDir) || getBaseNameFromPath(configFiles || "") || "Compose Stack";
    const detail = [workingDir, configFilesDisplay].filter(Boolean).join(" • ");

    return {
      key,
      title,
      detail,
    };
  }

  return {
    key: "ungrouped",
    title: "Ungrouped",
    detail: "",
  };
}

export function getServiceHost(server: DockerTargetServer): string {
  if (server.isLocal) {
    return "localhost";
  }

  const host = (server.host || "").trim();
  if (!host) {
    return "localhost";
  }

  return host.replace(/^https?:\/\//i, "");
}

export function inferServiceLinksFromPorts(portsValue: string, serviceHost: string): ServiceLink[] {
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

export function groupContainersByComposeFile(
  containers: DockerContainer[],
  serviceHost: string,
  statsLookup: Map<string, DockerContainerStat>
): DashboardContainerGroup[] {
  const grouped = new Map<string, DashboardContainerGroup>();

  for (const container of containers) {
    const dashboardContainer = {
      ...container,
      serviceLinks: inferServiceLinksFromPorts(container.Ports || "", serviceHost),
      resourceCpu: "-",
      resourceMemory: "-",
      resourceNetIo: "-",
      resourceBlockIo: "-",
    } as unknown as DashboardContainer;

    const stat = resolveContainerStat(container, statsLookup);
    if (stat) {
      dashboardContainer.resourceCpu = stat.CPUPerc || "-";
      dashboardContainer.resourceMemory = stat.MemUsage || "-";
      dashboardContainer.resourceNetIo = stat.NetIO || "-";
      dashboardContainer.resourceBlockIo = stat.BlockIO || "-";
    }

    const group = resolveComposeGroup(container);
    const existing = grouped.get(group.key);

    if (existing) {
      existing.containers.push(dashboardContainer);

      for (const link of dashboardContainer.serviceLinks) {
        if (!existing.serviceLinks.some((item) => item.url === link.url)) {
          existing.serviceLinks.push(link);
        }
      }

      existing.serviceLinks.sort((a, b) => a.port - b.port);
    } else {
      grouped.set(group.key, {
        key: group.key,
        title: group.title,
        detail: group.detail,
        containers: [dashboardContainer],
        serviceLinks: [...dashboardContainer.serviceLinks],
      });
    }
  }

  return Array.from(grouped.values())
    .map((group) => ({
      ...group,
      containers: group.containers.sort((a, b) => a.Names.localeCompare(b.Names)),
    }))
    .sort((a, b) => {
      if (a.title === "Ungrouped") {
        return 1;
      }
      if (b.title === "Ungrouped") {
        return -1;
      }
      return a.title.localeCompare(b.title);
    });
}

export function backgroundExtensionFromMimeType(mimeType: string): string | null {
  const normalized = (mimeType || "").toLowerCase();
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
  };
  return map[normalized] ?? null;
}

export function toSafeBackgroundStyle(backgroundImagePath: string): string {
  if (!backgroundImagePath) {
    return "";
  }

  const escapedPath = backgroundImagePath
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\"/g, '\\"');

  return `--hs-bg-image: url('${escapedPath}')`;
}
