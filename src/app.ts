import express from "express";
import fs from "fs/promises";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import cookieParser from "cookie-parser";
import multer from "multer";
import {
  consumeFlashSession,
  createManagedUser,
  ensureCsrf,
  getActiveServerSessionId,
  getPermissionFlags,
  handleLogin,
  listManagedUsers,
  logout,
  requireAuth,
  requirePermission,
  setActiveServerSession,
  setFlashSession,
  setManagedUserActiveStatus,
  updateManagedUser,
  deleteManagedUser,
} from "./lib/auth.js";
import {
  getDockerHostInfo,
  listContainerStats,
  listRunningContainers,
  removeContainer,
  startContainer,
  stopContainer,
  restartContainer,
  type DockerContainer,
  type DockerContainerStat,
  type DockerHostInfo,
  type DockerTargetServer,
} from "./lib/dockerCli.js";
import { PERMISSIONS, ROLES, type Role } from "./lib/rbac.js";
import { restartHost } from "./lib/systemCli.js";
import {
  createRemoteServer,
  deleteRemoteServer,
  getRemoteServerById,
  listRemoteServers,
  resolveServerByIdOrDefault,
  setDefaultServer,
  updateRemoteServer,
} from "./lib/remoteServers.js";
import {
  DEFAULT_DASHBOARD_SETTINGS,
  getDashboardBackgroundUploadsPath,
  getDashboardSettings,
  updateDashboardSettings,
  type DashboardSettings,
  type DashboardTheme,
} from "./lib/dashboardSettings.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type AppDeps = {
  listContainers: (server?: DockerTargetServer) => Promise<DockerContainer[]>;
  listContainerStats: (server?: DockerTargetServer) => Promise<DockerContainerStat[]>;
  getHostInfo: (server?: DockerTargetServer) => Promise<DockerHostInfo>;
  removeContainerById: (containerIdOrName: string, server?: DockerTargetServer) => Promise<void>;
  startContainerById: (containerIdOrName: string, server?: DockerTargetServer) => Promise<void>;
  stopContainerById: (containerIdOrName: string, server?: DockerTargetServer) => Promise<void>;
  restartContainerById: (containerIdOrName: string, server?: DockerTargetServer) => Promise<void>;
  restartHostMachine: typeof restartHost;
};

type DashboardContainerGroup = {
  key: string;
  title: string;
  detail: string;
  containers: DashboardContainer[];
  serviceLinks: ServiceLink[];
};

type ServiceLink = {
  port: number;
  containerPort: number;
  protocol: "http" | "https";
  url: string;
  label: string;
};

type DashboardContainer = DockerContainer & {
  serviceLinks: ServiceLink[];
  resourceCpu: string;
  resourceMemory: string;
  resourceNetIo: string;
  resourceBlockIo: string;
};

type DashboardServerMetrics = {
  cpuCores: string;
  totalMemory: string;
  usedMemory: string;
  memoryUtilization: string;
  monitoredContainers: number;
  available: boolean;
  warning: string;
};

type ResolvedComposeGroup = {
  key: string;
  title: string;
  detail: string;
};

function resolveDashboardTheme(value: unknown): DashboardTheme {
  return value === "light" ? "light" : "dark";
}

function backgroundExtensionFromMimeType(mimeType: string): string | null {
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

function toSafeBackgroundStyle(backgroundImagePath: string): string {
  if (!backgroundImagePath) {
    return "";
  }

  const escapedPath = backgroundImagePath
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\"/g, '\\"');

  return `--hs-bg-image: url('${escapedPath}')`;
}

const defaultDeps: AppDeps = {
  listContainers: listRunningContainers,
  listContainerStats,
  getHostInfo: getDockerHostInfo,
  removeContainerById: removeContainer,
  startContainerById: startContainer,
  stopContainerById: stopContainer,
  restartContainerById: restartContainer,
  restartHostMachine: restartHost,
};

function normalizeContainerIdentifier(identifier: string): string {
  return (identifier || "").trim().toLowerCase();
}

function parseHumanSizeToBytes(value: string): number | null {
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

function parseUsedMemoryFromMemUsage(memUsage: string): number | null {
  const usedSegment = (memUsage || "").split("/")[0]?.trim() || "";
  return parseHumanSizeToBytes(usedSegment);
}

function formatBytes(value: number): string {
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

function buildContainerStatsLookup(stats: DockerContainerStat[]): Map<string, DockerContainerStat> {
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

function resolveContainerStat(container: DockerContainer, statsLookup: Map<string, DockerContainerStat>): DockerContainerStat | null {
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

function createUnavailableServerMetrics(warning: string): DashboardServerMetrics {
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

function buildServerMetrics(hostInfo: DockerHostInfo | null, stats: DockerContainerStat[], warning: string): DashboardServerMetrics {
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

function toBooleanFormValue(value: unknown, defaultValue = false): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => toBooleanFormValue(item, false));
  }

  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  return value === true || value === "true" || value === "on" || value === "1";
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") {
    return [value];
  }
  return [];
}

function getSelectedContainerIdsFromBody(body: unknown): string[] {
  const bodyRecord = (body && typeof body === "object") ? (body as Record<string, unknown>) : {};

  return [
    ...toStringArray(bodyRecord.containers),
    ...toStringArray(bodyRecord["containers[]"]),
  ]
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index);
}

function isContainerRunning(container: DockerContainer): boolean {
  const stateText = (container.State || "").toLowerCase();
  const statusText = (container.Status || "").toLowerCase();
  return stateText === "running" || statusText.startsWith("up");
}

function containerMatchesIdentifier(container: DockerContainer, identifier: string): boolean {
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

function parseDockerLabels(labels: string): Record<string, string> {
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

function getServiceHost(server: DockerTargetServer): string {
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

function groupContainersByComposeFile(
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

export function createApp(partialDeps?: Partial<AppDeps>) {
  const deps = { ...defaultDeps, ...partialDeps };
  const app = express();
  const dashboardUploadsDir = getDashboardBackgroundUploadsPath();
  const dashboardUploadsRootDir = path.dirname(dashboardUploadsDir);
  const dashboardUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 10 * 1024 * 1024,
    },
  });

  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "views"));
  app.use("/public", express.static(path.join(__dirname, "public")));
  app.use("/uploads", express.static(dashboardUploadsRootDir));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser(process.env.COOKIE_SECRET || "dev-secret"));

  void fs.mkdir(dashboardUploadsDir, { recursive: true });

  app.use(async (_req, res, next) => {
    try {
      const dashboardSettings = await getDashboardSettings();
      res.locals.dashboardSettings = dashboardSettings;
      const bodyClassParts = ["hs-body", `hs-theme-${dashboardSettings.theme}`];
      if (dashboardSettings.backgroundImagePath) {
        bodyClassParts.push("hs-has-background");
      }
      res.locals.pageBodyClass = bodyClassParts.join(" ");
      res.locals.pageBackgroundStyle = toSafeBackgroundStyle(dashboardSettings.backgroundImagePath);
      res.locals.pageBackgroundImagePath = dashboardSettings.backgroundImagePath;
      next();
    } catch {
      const fallbackSettings: DashboardSettings = { ...DEFAULT_DASHBOARD_SETTINGS };
      res.locals.dashboardSettings = fallbackSettings;
      res.locals.pageBodyClass = `hs-body hs-theme-${fallbackSettings.theme}`;
      res.locals.pageBackgroundStyle = "";
      res.locals.pageBackgroundImagePath = "";
      next();
    }
  });

  app.get("/login", (_req, res) => {
    res.render("login", { error: "", username: "" });
  });

  app.post("/login", async (req, res, next) => {
    try {
      await handleLogin(req, res);
    } catch (err) {
      next(err);
    }
  });

  app.post("/logout", requireAuth, ensureCsrf, logout);

  app.get("/", requireAuth, requirePermission(PERMISSIONS.CONTAINERS_VIEW), async (req, res) => {
    try {
      const { servers, defaultServerId } = await listRemoteServers();
      const selectedFromSession = getActiveServerSessionId(req);
      const { server: activeServer } = await resolveServerByIdOrDefault(selectedFromSession);
      setActiveServerSession(res, req, activeServer.id);

      const containers = await deps.listContainers(activeServer);
      const [statsResult, hostInfoResult] = await Promise.allSettled([
        deps.listContainerStats(activeServer),
        deps.getHostInfo(activeServer),
      ]);

      const metricsWarning = (statsResult.status === "rejected" || hostInfoResult.status === "rejected")
        ? "Resource metrics are temporarily unavailable for this server."
        : "";

      const containerStats = statsResult.status === "fulfilled" ? statsResult.value : [];
      const hostInfo = hostInfoResult.status === "fulfilled" ? hostInfoResult.value : null;
      const statsLookup = buildContainerStatsLookup(containerStats);
      const groupedContainers = groupContainersByComposeFile(containers, getServiceHost(activeServer), statsLookup);
      const serverMetrics = buildServerMetrics(hostInfo, containerStats, metricsWarning);
      const can = getPermissionFlags(req.user);
      const { notice, error } = consumeFlashSession(res, req);

      res.render("dashboard", {
        user: req.user,
        can,
        containers,
        groupedContainers,
        serverMetrics,
        metricsWarning,
        csrfToken: req.csrfToken,
        notice,
        error,
        servers,
        activeServerId: activeServer.id,
        defaultServerId,
      });
    } catch (e) {
      const error = e as Error;
      res.status(500).render("dashboard", {
        user: req.user,
        can: getPermissionFlags(req.user),
        containers: [],
        groupedContainers: [],
        serverMetrics: createUnavailableServerMetrics(""),
        metricsWarning: "",
        csrfToken: req.csrfToken,
        notice: "",
        error: `Dashboard error: ${error.message}`,
        servers: [],
        activeServerId: "",
        defaultServerId: "local",
      });
    }
  });

  app.post(
    "/servers/switch",
    requireAuth,
    ensureCsrf,
    requirePermission(PERMISSIONS.SERVERS_SWITCH),
    async (req, res) => {
      try {
        const serverId = typeof req.body?.serverId === "string" ? req.body.serverId : "";
        const target = await getRemoteServerById(serverId);
        if (!target || !target.enabled) {
          throw new Error("Server is unavailable");
        }

        setActiveServerSession(res, req, target.id);

        console.info("AUDIT server_switch", {
          actor: req.user?.username,
          role: req.user?.role,
          target: target.id,
          at: new Date().toISOString(),
          result: "success",
        });

        setFlashSession(res, req, { notice: "Server switched successfully" });
        res.redirect("/");
      } catch (error) {
        setFlashSession(res, req, { error: (error as Error).message || "Failed to switch server" });
        res.redirect("/");
      }
    }
  );

  app.post(
    "/users",
    requireAuth,
    ensureCsrf,
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
      try {
        const username = typeof req.body?.username === "string" ? req.body.username : "";
        const password = typeof req.body?.password === "string" ? req.body.password : "";
        const roleInput = typeof req.body?.role === "string" ? req.body.role : "";

        const validRoles = Object.values(ROLES) as Role[];
        const role = validRoles.includes(roleInput as Role) ? (roleInput as Role) : ROLES.VIEWER;

        await createManagedUser({ username, password, role });
        setFlashSession(res, req, { notice: "User created successfully" });
        res.redirect("/users");
      } catch (error) {
        setFlashSession(res, req, { error: (error as Error).message || "Failed to create user" });
        res.redirect("/users");
      }
    }
  );

  app.post(
    "/users/:userId/disable",
    requireAuth,
    ensureCsrf,
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
      try {
        await setManagedUserActiveStatus({
          userId: req.params.userId,
          active: false,
          actorUserId: req.user!.id,
        });
        setFlashSession(res, req, { notice: "User disabled successfully" });
        res.redirect("/users");
      } catch (error) {
        setFlashSession(res, req, { error: (error as Error).message || "Failed to disable user" });
        res.redirect("/users");
      }
    }
  );

  app.post(
    "/users/:userId/enable",
    requireAuth,
    ensureCsrf,
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
      try {
        await setManagedUserActiveStatus({
          userId: req.params.userId,
          active: true,
          actorUserId: req.user!.id,
        });
        setFlashSession(res, req, { notice: "User enabled successfully" });
        res.redirect("/users");
      } catch (error) {
        setFlashSession(res, req, { error: (error as Error).message || "Failed to enable user" });
        res.redirect("/users");
      }
    }
  );

  app.post(
    "/users/:userId/update",
    requireAuth,
    ensureCsrf,
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
      try {
        const roleInput = typeof req.body?.role === "string" ? req.body.role : "";
        const password = typeof req.body?.password === "string" ? req.body.password : "";

        const validRoles = Object.values(ROLES) as Role[];
        const role = validRoles.includes(roleInput as Role) ? (roleInput as Role) : ROLES.VIEWER;

        await updateManagedUser({
          userId: req.params.userId,
          actorUserId: req.user!.id,
          role,
          password,
        });

        setFlashSession(res, req, { notice: "User updated successfully" });
        res.redirect("/users");
      } catch (error) {
        setFlashSession(res, req, { error: (error as Error).message || "Failed to update user" });
        res.redirect("/users");
      }
    }
  );

  app.post(
    "/users/:userId/delete",
    requireAuth,
    ensureCsrf,
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
      try {
        await deleteManagedUser({
          userId: req.params.userId,
          actorUserId: req.user!.id,
        });
        setFlashSession(res, req, { notice: "User removed successfully" });
        res.redirect("/users");
      } catch (error) {
        setFlashSession(res, req, { error: (error as Error).message || "Failed to remove user" });
        res.redirect("/users");
      }
    }
  );

  app.get(
    "/users",
    requireAuth,
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
      try {
        const users = await listManagedUsers(req.user!.id);
        const can = getPermissionFlags(req.user);
        const { notice, error } = consumeFlashSession(res, req);

        res.render("users", {
          user: req.user,
          can,
          users,
          roles: Object.values(ROLES),
          csrfToken: req.csrfToken,
          notice,
          error,
        });
      } catch (error) {
        res.status(500).render("users", {
          user: req.user,
          can: getPermissionFlags(req.user),
          users: [],
          roles: Object.values(ROLES),
          csrfToken: req.csrfToken,
          notice: "",
          error: `Failed to load users: ${(error as Error).message}`,
        });
      }
    }
  );

  app.get(
    "/settings",
    requireAuth,
    requirePermission(PERMISSIONS.SETTINGS_MANAGE),
    async (req, res) => {
      const can = getPermissionFlags(req.user);
      const { notice, error } = consumeFlashSession(res, req);
      res.render("settings", {
        user: req.user,
        can,
        settings: res.locals.dashboardSettings,
        csrfToken: req.csrfToken,
        notice,
        error,
      });
    }
  );

  app.post(
    "/settings",
    requireAuth,
    requirePermission(PERMISSIONS.SETTINGS_MANAGE),
    dashboardUpload.single("backgroundImage"),
    ensureCsrf,
    async (req, res) => {
      try {
        const patch: Partial<DashboardSettings> = {
          appTitle: typeof req.body?.appTitle === "string" ? req.body.appTitle : "",
          appSlogan: typeof req.body?.appSlogan === "string" ? req.body.appSlogan : "",
          theme: resolveDashboardTheme(req.body?.theme),
          showContainerResources: toBooleanFormValue(req.body?.showContainerResources, true),
          showServerResources: toBooleanFormValue(req.body?.showServerResources, true),
          showImageName: toBooleanFormValue(req.body?.showImageName, true),
          showContainerHash: toBooleanFormValue(req.body?.showContainerHash, true),
        };

        if (req.file) {
          const extension = backgroundExtensionFromMimeType(req.file.mimetype);
          if (!extension) {
            throw new Error("Background image must be png, jpg, jpeg, webp, or gif");
          }

          await fs.mkdir(dashboardUploadsDir, { recursive: true });
          const filename = `bg-${Date.now()}-${crypto.randomUUID()}${extension}`;
          const targetPath = path.join(dashboardUploadsDir, filename);
          await fs.writeFile(targetPath, req.file.buffer);
          patch.backgroundImagePath = `/uploads/backgrounds/${filename}`;
        }

        await updateDashboardSettings(patch);
        setFlashSession(res, req, { notice: "Dashboard settings updated successfully" });
        res.redirect("/settings");
      } catch (error) {
        setFlashSession(res, req, { error: (error as Error).message || "Failed to update dashboard settings" });
        res.redirect("/settings");
      }
    }
  );

  app.get(
    "/servers",
    requireAuth,
    requirePermission(PERMISSIONS.SERVERS_MANAGE),
    async (req, res) => {
      try {
        const { servers, defaultServerId } = await listRemoteServers();
        const { notice, error } = consumeFlashSession(res, req);

        res.render("servers", {
          user: req.user,
          can: getPermissionFlags(req.user),
          servers,
          defaultServerId,
          csrfToken: req.csrfToken,
          notice,
          error,
        });
      } catch (error) {
        res.status(500).render("servers", {
          user: req.user,
          can: getPermissionFlags(req.user),
          servers: [],
          defaultServerId: "local",
          csrfToken: req.csrfToken,
          notice: "",
          error: `Failed to load servers: ${(error as Error).message}`,
        });
      }
    }
  );

  app.post(
    "/servers",
    requireAuth,
    ensureCsrf,
    requirePermission(PERMISSIONS.SERVERS_MANAGE),
    async (req, res) => {
      try {
        await createRemoteServer({
          name: typeof req.body?.name === "string" ? req.body.name : "",
          host: typeof req.body?.host === "string" ? req.body.host : "",
          username: typeof req.body?.username === "string" ? req.body.username : "",
          password: typeof req.body?.password === "string" ? req.body.password : "",
          enabled: toBooleanFormValue(req.body?.enabled),
        });
        setFlashSession(res, req, { notice: "Server created successfully" });
        res.redirect("/servers");
      } catch (error) {
        setFlashSession(res, req, { error: (error as Error).message || "Failed to create server" });
        res.redirect("/servers");
      }
    }
  );

  app.post(
    "/servers/:serverId/update",
    requireAuth,
    ensureCsrf,
    requirePermission(PERMISSIONS.SERVERS_MANAGE),
    async (req, res) => {
      try {
        await updateRemoteServer(req.params.serverId, {
          name: typeof req.body?.name === "string" ? req.body.name : "",
          host: typeof req.body?.host === "string" ? req.body.host : "",
          username: typeof req.body?.username === "string" ? req.body.username : "",
          password: typeof req.body?.password === "string" ? req.body.password : undefined,
          enabled: toBooleanFormValue(req.body?.enabled),
        });

        const { server } = await resolveServerByIdOrDefault(getActiveServerSessionId(req));
        setActiveServerSession(res, req, server.id);
        setFlashSession(res, req, { notice: "Server updated successfully" });
        res.redirect("/servers");
      } catch (error) {
        setFlashSession(res, req, { error: (error as Error).message || "Failed to update server" });
        res.redirect("/servers");
      }
    }
  );

  app.post(
    "/servers/:serverId/delete",
    requireAuth,
    ensureCsrf,
    requirePermission(PERMISSIONS.SERVERS_MANAGE),
    async (req, res) => {
      try {
        await deleteRemoteServer(req.params.serverId);
        const { server } = await resolveServerByIdOrDefault(getActiveServerSessionId(req));
        setActiveServerSession(res, req, server.id);
        setFlashSession(res, req, { notice: "Server removed successfully" });
        res.redirect("/servers");
      } catch (error) {
        setFlashSession(res, req, { error: (error as Error).message || "Failed to delete server" });
        res.redirect("/servers");
      }
    }
  );

  app.post(
    "/servers/:serverId/default",
    requireAuth,
    ensureCsrf,
    requirePermission(PERMISSIONS.SERVERS_MANAGE),
    async (req, res) => {
      try {
        await setDefaultServer(req.params.serverId);
        setFlashSession(res, req, { notice: "Default server updated successfully" });
        res.redirect("/servers");
      } catch (error) {
        setFlashSession(res, req, { error: (error as Error).message || "Failed to set default server" });
        res.redirect("/servers");
      }
    }
  );

  app.post(
    "/containers/:containerId/remove",
    requireAuth,
    ensureCsrf,
    requirePermission(PERMISSIONS.CONTAINERS_RESTART),
    async (req, res) => {
      try {
        const { containerId } = req.params;
        const { server } = await resolveServerByIdOrDefault(getActiveServerSessionId(req));
        const containers = await deps.listContainers(server);
        const target = containers.find((container) => containerMatchesIdentifier(container, containerId));

        if (!target) {
          throw new Error("Container not found");
        }

        if (isContainerRunning(target)) {
          throw new Error("Container must be stopped before removing");
        }

        await deps.removeContainerById(containerId, server);

        console.info("AUDIT container_remove", {
          actor: req.user?.username,
          role: req.user?.role,
          target: containerId,
          server: server.id,
          at: new Date().toISOString(),
          result: "success",
        });

        setFlashSession(res, req, { notice: "Container removed successfully" });
        res.redirect("/");
      } catch (error) {
        console.warn("AUDIT container_remove", {
          actor: req.user?.username,
          role: req.user?.role,
          target: req.params.containerId,
          at: new Date().toISOString(),
          result: "error",
          message: (error as Error).message,
        });

        setFlashSession(res, req, { error: (error as Error).message || "Failed to remove container" });
        res.redirect("/");
      }
    }
  );

  app.post(
    "/containers/:containerId/start",
    requireAuth,
    ensureCsrf,
    requirePermission(PERMISSIONS.CONTAINERS_RESTART),
    async (req, res) => {
      try {
        const { containerId } = req.params;
        const { server } = await resolveServerByIdOrDefault(getActiveServerSessionId(req));
        await deps.startContainerById(containerId, server);

        console.info("AUDIT container_start", {
          actor: req.user?.username,
          role: req.user?.role,
          target: containerId,
          server: server.id,
          at: new Date().toISOString(),
          result: "success",
        });

        setFlashSession(res, req, { notice: "Container started successfully" });
        res.redirect("/");
      } catch (error) {
        console.warn("AUDIT container_start", {
          actor: req.user?.username,
          role: req.user?.role,
          target: req.params.containerId,
          at: new Date().toISOString(),
          result: "error",
          message: (error as Error).message,
        });

        setFlashSession(res, req, { error: "Failed to start container" });
        res.redirect("/");
      }
    }
  );

  app.post(
    "/containers/:containerId/stop",
    requireAuth,
    ensureCsrf,
    requirePermission(PERMISSIONS.CONTAINERS_RESTART),
    async (req, res) => {
      try {
        const { containerId } = req.params;
        const { server } = await resolveServerByIdOrDefault(getActiveServerSessionId(req));
        await deps.stopContainerById(containerId, server);

        console.info("AUDIT container_stop", {
          actor: req.user?.username,
          role: req.user?.role,
          target: containerId,
          server: server.id,
          at: new Date().toISOString(),
          result: "success",
        });

        setFlashSession(res, req, { notice: "Container stopped successfully" });
        res.redirect("/");
      } catch (error) {
        console.warn("AUDIT container_stop", {
          actor: req.user?.username,
          role: req.user?.role,
          target: req.params.containerId,
          at: new Date().toISOString(),
          result: "error",
          message: (error as Error).message,
        });

        setFlashSession(res, req, { error: "Failed to stop container" });
        res.redirect("/");
      }
    }
  );

  app.post(
    "/containers/:containerId/restart",
    requireAuth,
    ensureCsrf,
    requirePermission(PERMISSIONS.CONTAINERS_RESTART),
    async (req, res) => {
      try {
        const { containerId } = req.params;
        const { server } = await resolveServerByIdOrDefault(getActiveServerSessionId(req));
        await deps.restartContainerById(containerId, server);

        console.info("AUDIT container_restart", {
          actor: req.user?.username,
          role: req.user?.role,
          target: containerId,
          server: server.id,
          at: new Date().toISOString(),
          result: "success",
        });

        setFlashSession(res, req, { notice: "Container restarted successfully" });
        res.redirect("/");
      } catch (error) {
        console.warn("AUDIT container_restart", {
          actor: req.user?.username,
          role: req.user?.role,
          target: req.params.containerId,
          at: new Date().toISOString(),
          result: "error",
          message: (error as Error).message,
        });

        setFlashSession(res, req, { error: "Failed to restart container" });
        res.redirect("/");
      }
    }
  );

  app.post(
    "/containers/remove",
    requireAuth,
    ensureCsrf,
    requirePermission(PERMISSIONS.CONTAINERS_RESTART),
    async (req, res) => {
      const selectedContainerIds = getSelectedContainerIdsFromBody(req.body);

      if (!selectedContainerIds.length) {
        setFlashSession(res, req, { error: "No containers selected" });
        res.redirect("/");
        return;
      }

      const removed: string[] = [];
      const failed: string[] = [];
      const running: string[] = [];

      try {
        const { server } = await resolveServerByIdOrDefault(getActiveServerSessionId(req));
        const containers = await deps.listContainers(server);

        for (const containerId of selectedContainerIds) {
          const target = containers.find((container) => containerMatchesIdentifier(container, containerId));

          if (!target) {
            failed.push(containerId);
            continue;
          }

          if (isContainerRunning(target)) {
            running.push(containerId);
            continue;
          }

          try {
            await deps.removeContainerById(containerId, server);
            removed.push(containerId);
          } catch {
            failed.push(containerId);
          }
        }

        console.info("AUDIT container_remove_bulk", {
          actor: req.user?.username,
          role: req.user?.role,
          targets: selectedContainerIds,
          removed,
          running,
          failed,
          server: server.id,
          at: new Date().toISOString(),
          result: (failed.length || running.length) ? (removed.length ? "partial" : "error") : "success",
        });

        if (!running.length && !failed.length) {
          setFlashSession(res, req, { notice: `${removed.length} container(s) removed successfully` });
          res.redirect("/");
          return;
        }

        if (!removed.length) {
          const runningMessage = running.length
            ? `Cannot remove running container(s): ${running.join(", ")}`
            : "";
          const failedMessage = failed.length
            ? `Failed to remove: ${failed.join(", ")}`
            : "";
          setFlashSession(res, req, {
            error: [runningMessage, failedMessage].filter(Boolean).join(". ") || "Failed to remove selected containers",
          });
          res.redirect("/");
          return;
        }

        const runningMessage = running.length
          ? `Skipped running: ${running.join(", ")}`
          : "";
        const failedMessage = failed.length
          ? `Failed: ${failed.join(", ")}`
          : "";
        setFlashSession(res, req, {
          error: `Removed ${removed.length} container(s). ${[runningMessage, failedMessage].filter(Boolean).join(". ")}`,
        });
        res.redirect("/");
      } catch (error) {
        console.warn("AUDIT container_remove_bulk", {
          actor: req.user?.username,
          role: req.user?.role,
          targets: selectedContainerIds,
          at: new Date().toISOString(),
          result: "error",
          message: (error as Error).message,
        });

        setFlashSession(res, req, { error: "Failed to remove selected containers" });
        res.redirect("/");
      }
    }
  );

  app.post(
    "/containers/start",
    requireAuth,
    ensureCsrf,
    requirePermission(PERMISSIONS.CONTAINERS_RESTART),
    async (req, res) => {
      const selectedContainerIds = getSelectedContainerIdsFromBody(req.body);

      if (!selectedContainerIds.length) {
        setFlashSession(res, req, { error: "No containers selected" });
        res.redirect("/");
        return;
      }

      const started: string[] = [];
      const failed: string[] = [];

      try {
        const { server } = await resolveServerByIdOrDefault(getActiveServerSessionId(req));

        for (const containerId of selectedContainerIds) {
          try {
            await deps.startContainerById(containerId, server);
            started.push(containerId);
          } catch {
            failed.push(containerId);
          }
        }

        console.info("AUDIT container_start_bulk", {
          actor: req.user?.username,
          role: req.user?.role,
          targets: selectedContainerIds,
          started,
          failed,
          server: server.id,
          at: new Date().toISOString(),
          result: failed.length ? (started.length ? "partial" : "error") : "success",
        });

        if (!failed.length) {
          setFlashSession(res, req, { notice: `${started.length} container(s) started successfully` });
          res.redirect("/");
          return;
        }

        if (!started.length) {
          setFlashSession(res, req, { error: "Failed to start selected containers" });
          res.redirect("/");
          return;
        }

        setFlashSession(res, req, {
          error: `Started ${started.length} container(s), failed ${failed.length}: ${failed.join(", ")}`,
        });
        res.redirect("/");
      } catch (error) {
        console.warn("AUDIT container_start_bulk", {
          actor: req.user?.username,
          role: req.user?.role,
          targets: selectedContainerIds,
          at: new Date().toISOString(),
          result: "error",
          message: (error as Error).message,
        });

        setFlashSession(res, req, { error: "Failed to start selected containers" });
        res.redirect("/");
      }
    }
  );

  app.post(
    "/containers/stop",
    requireAuth,
    ensureCsrf,
    requirePermission(PERMISSIONS.CONTAINERS_RESTART),
    async (req, res) => {
      const selectedContainerIds = getSelectedContainerIdsFromBody(req.body);

      if (!selectedContainerIds.length) {
        setFlashSession(res, req, { error: "No containers selected" });
        res.redirect("/");
        return;
      }

      const stopped: string[] = [];
      const failed: string[] = [];

      try {
        const { server } = await resolveServerByIdOrDefault(getActiveServerSessionId(req));

        for (const containerId of selectedContainerIds) {
          try {
            await deps.stopContainerById(containerId, server);
            stopped.push(containerId);
          } catch {
            failed.push(containerId);
          }
        }

        console.info("AUDIT container_stop_bulk", {
          actor: req.user?.username,
          role: req.user?.role,
          targets: selectedContainerIds,
          stopped,
          failed,
          server: server.id,
          at: new Date().toISOString(),
          result: failed.length ? (stopped.length ? "partial" : "error") : "success",
        });

        if (!failed.length) {
          setFlashSession(res, req, { notice: `${stopped.length} container(s) stopped successfully` });
          res.redirect("/");
          return;
        }

        if (!stopped.length) {
          setFlashSession(res, req, { error: "Failed to stop selected containers" });
          res.redirect("/");
          return;
        }

        setFlashSession(res, req, {
          error: `Stopped ${stopped.length} container(s), failed ${failed.length}: ${failed.join(", ")}`,
        });
        res.redirect("/");
      } catch (error) {
        console.warn("AUDIT container_stop_bulk", {
          actor: req.user?.username,
          role: req.user?.role,
          targets: selectedContainerIds,
          at: new Date().toISOString(),
          result: "error",
          message: (error as Error).message,
        });

        setFlashSession(res, req, { error: "Failed to stop selected containers" });
        res.redirect("/");
      }
    }
  );

  app.post(
    "/containers/restart",
    requireAuth,
    ensureCsrf,
    requirePermission(PERMISSIONS.CONTAINERS_RESTART),
    async (req, res) => {
      const selectedContainerIds = getSelectedContainerIdsFromBody(req.body);

      if (!selectedContainerIds.length) {
        setFlashSession(res, req, { error: "No containers selected" });
        res.redirect("/");
        return;
      }

      const restarted: string[] = [];
      const failed: string[] = [];

      try {
        const { server } = await resolveServerByIdOrDefault(getActiveServerSessionId(req));

        for (const containerId of selectedContainerIds) {
          try {
            await deps.restartContainerById(containerId, server);
            restarted.push(containerId);
          } catch {
            failed.push(containerId);
          }
        }

        console.info("AUDIT container_restart_bulk", {
          actor: req.user?.username,
          role: req.user?.role,
          targets: selectedContainerIds,
          restarted,
          failed,
          server: server.id,
          at: new Date().toISOString(),
          result: failed.length ? (restarted.length ? "partial" : "error") : "success",
        });

        if (!failed.length) {
          setFlashSession(res, req, { notice: `${restarted.length} container(s) restarted successfully` });
          res.redirect("/");
          return;
        }

        if (!restarted.length) {
          setFlashSession(res, req, { error: "Failed to restart selected containers" });
          res.redirect("/");
          return;
        }

        setFlashSession(res, req, {
          error: `Restarted ${restarted.length} container(s), failed ${failed.length}: ${failed.join(", ")}`,
        });
        res.redirect("/");
      } catch (error) {
        console.warn("AUDIT container_restart_bulk", {
          actor: req.user?.username,
          role: req.user?.role,
          targets: selectedContainerIds,
          at: new Date().toISOString(),
          result: "error",
          message: (error as Error).message,
        });

        setFlashSession(res, req, { error: "Failed to restart selected containers" });
        res.redirect("/");
      }
    }
  );

  app.post(
    "/host/restart",
    requireAuth,
    ensureCsrf,
    requirePermission(PERMISSIONS.HOST_RESTART),
    async (req, res) => {
      try {
        await deps.restartHostMachine();

        console.info("AUDIT host_restart", {
          actor: req.user?.username,
          role: req.user?.role,
          at: new Date().toISOString(),
          result: "success",
        });

        setFlashSession(res, req, { notice: "Host restart command issued" });
        res.redirect("/");
      } catch (error) {
        console.warn("AUDIT host_restart", {
          actor: req.user?.username,
          role: req.user?.role,
          at: new Date().toISOString(),
          result: "error",
          message: (error as Error).message,
        });

        setFlashSession(res, req, { error: "Failed to restart host" });
        res.redirect("/");
      }
    }
  );

  return app;
}
