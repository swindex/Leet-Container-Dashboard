import express from "express";
import fs from "fs/promises";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import cookieParser from "cookie-parser";
import {
  listRunningContainers,
  listContainerStats,
  getDockerHostInfo,
  removeContainer,
  startContainer,
  stopContainer,
  restartContainer,
  type DockerContainer,
  type DockerContainerStat,
  type DockerHostInfo,
  type DockerTargetServer,
} from "./lib/dockerCli.js";
import { restartHost } from "./lib/systemCli.js";
import {
  DEFAULT_DASHBOARD_SETTINGS,
  getDashboardBackgroundUploadsPath,
  getLaunchpadIconsUploadsPath,
  getDashboardSettings,
  type DashboardSettings,
} from "./lib/dashboardSettings.js";
import { isDemoMode } from "./lib/demoMode.js";
import { listRemoteServers } from "./lib/remoteServers.js";
import { listLaunchpadItems, shouldSyncImmediately } from "./lib/launchpadItems.js";
import { syncLaunchpadItemsForServer } from "./lib/launchpadSync.js";
import { toSafeBackgroundStyle } from "./lib/routerHelpers.js";
import { createAuthRouter } from "./routes/auth.router.js";
import { createUsersRouter } from "./routes/users.router.js";
import { createDashboardRouter } from "./routes/dashboard.router.js";
import { createLaunchpadRouter } from "./routes/launchpad.router.js";
import { createServersRouter } from "./routes/servers.router.js";
import { createSettingsRouter } from "./routes/settings.router.js";

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

function resolveCookieSecret(): string {
  const cookieSecret = process.env.COOKIE_SECRET?.trim();
  if (cookieSecret) {
    return cookieSecret;
  }

  console.warn("COOKIE_SECRET is not set. Using an ephemeral secret for this process.");
  return crypto.randomBytes(32).toString("hex");
}

export function createApp(partialDeps?: Partial<AppDeps>) {
  const deps = { ...defaultDeps, ...partialDeps };
  const app = express();
  const cookieSecret = resolveCookieSecret();
  const dashboardUploadsDir = getDashboardBackgroundUploadsPath();
  const launchpadIconsDir = getLaunchpadIconsUploadsPath();
  const dashboardUploadsRootDir = path.dirname(dashboardUploadsDir);

  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "views"));
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.use("/public", express.static(path.join(__dirname, "public")));
  app.use("/uploads", express.static(dashboardUploadsRootDir));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser(cookieSecret));

  void fs.mkdir(dashboardUploadsDir, { recursive: true });
  void fs.mkdir(launchpadIconsDir, { recursive: true });

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
      res.locals.isDemoMode = isDemoMode();
      next();
    } catch {
      const fallbackSettings: DashboardSettings = { ...DEFAULT_DASHBOARD_SETTINGS };
      res.locals.dashboardSettings = fallbackSettings;
      res.locals.pageBodyClass = `hs-body hs-theme-${fallbackSettings.theme}`;
      res.locals.pageBackgroundStyle = "";
      res.locals.pageBackgroundImagePath = "";
      res.locals.isDemoMode = isDemoMode();
      next();
    }
  });

  // Mount routers
  app.use(createAuthRouter());
  app.use(createUsersRouter());
  app.use(createDashboardRouter(deps));
  app.use(createLaunchpadRouter());
  app.use(createServersRouter());
  app.use(createSettingsRouter());

  // Background launchpad sync for all servers
  async function syncAllServersLaunchpad() {
    try {
      const { servers } = await listRemoteServers();
      
      for (const server of servers) {
        if (!server.enabled) {
          continue;
        }
        
        try {
          const containers = await deps.listContainers(server);
          await syncLaunchpadItemsForServer(server, containers);
        } catch (error) {
          console.warn(`[Launchpad] Sync failed for ${server.name || server.id}:`, (error as Error).message);
        }
      }
    } catch (error) {
      console.error("[Launchpad] Failed to sync all servers:", (error as Error).message);
    }
  }

  // Run immediate sync if data is old or empty
  void shouldSyncImmediately().then((shouldSync) => {
    if (shouldSync) {
      console.log("[Launchpad] Running initial sync...");
      void syncAllServersLaunchpad();
    }
  });

  // Background sync every 30 seconds
  setInterval(() => {
    void syncAllServersLaunchpad();
  }, 30_000);

  return app;
}
