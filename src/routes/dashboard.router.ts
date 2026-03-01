import { Router } from "express";
import type { Request, Response } from "express";
import {
  consumeFlashSession,
  ensureCsrf,
  getActiveServerSessionId,
  getPermissionFlags,
  requireAuth,
  requirePermission,
  setActiveServerSession,
  setFlashSession,
} from "../lib/auth.js";
import type { DockerContainer, DockerContainerStat, DockerHostInfo, DockerTargetServer } from "../lib/dockerCli.js";
import { PERMISSIONS } from "../lib/rbac.js";
import { resolveServerByIdOrDefault, listRemoteServers } from "../lib/remoteServers.js";
import { getCachedDockerData } from "../lib/dockerStatsCache.js";
import { setPendingAction, getPendingActionsForServer } from "../lib/pendingActions.js";
import {
  buildContainerStatsLookup,
  buildServerMetrics,
  containerMatchesIdentifier,
  getSelectedContainerIdsFromBody,
  getServiceHost,
  groupContainersByComposeFile,
  isContainerRunning,
  isLocalDockerUnavailableError,
  buildLaunchpadTiles,
} from "../lib/routerHelpers.js";

type AppDeps = {
  listContainers: (server?: DockerTargetServer) => Promise<DockerContainer[]>;
  listContainerStats: (server?: DockerTargetServer) => Promise<DockerContainerStat[]>;
  getHostInfo: (server?: DockerTargetServer) => Promise<DockerHostInfo>;
  removeContainerById: (containerIdOrName: string, server?: DockerTargetServer) => Promise<void>;
  startContainerById: (containerIdOrName: string, server?: DockerTargetServer) => Promise<void>;
  stopContainerById: (containerIdOrName: string, server?: DockerTargetServer) => Promise<void>;
  restartContainerById: (containerIdOrName: string, server?: DockerTargetServer) => Promise<void>;
  restartHostMachine: () => Promise<void>;
};

// Helper function to fetch dashboard data (used by both HTML and API routes)
async function fetchDashboardData(req: Request, res: Response, deps: AppDeps) {
  const { servers, defaultServerId } = await listRemoteServers();
  const selectedFromSession = getActiveServerSessionId(req);
  const { server: initiallyResolvedServer } = await resolveServerByIdOrDefault(selectedFromSession);
  const localServer = servers.find((server) => server.id === "local") ?? servers[0];
  let activeServer = initiallyResolvedServer;
  let unavailableServerIds: string[] = [];
  let fallbackError = "";
  let containers: DockerContainer[] = [];
  let containerStats: DockerContainerStat[] = [];
  let hostInfo: DockerHostInfo | null = null;
  let cacheAge = 0;

  try {
    // Use cached Docker data with 10-second TTL
    const cachedData = await getCachedDockerData(activeServer, async () => {
      const [fetchedContainers, fetchedStats, fetchedHostInfo] = await Promise.all([
        deps.listContainers(activeServer),
        deps.listContainerStats(activeServer),
        deps.getHostInfo(activeServer),
      ]);
      return {
        containers: fetchedContainers,
        stats: fetchedStats,
        hostInfo: fetchedHostInfo,
      };
    });

    containers = cachedData.containers;
    containerStats = cachedData.stats;
    hostInfo = cachedData.hostInfo;
    cacheAge = cachedData.cacheAge;
  } catch (primaryError) {
    if (activeServer.isLocal || !localServer || activeServer.id === localServer.id) {
      if (!activeServer.isLocal || !isLocalDockerUnavailableError(primaryError)) {
        throw primaryError;
      }

      fallbackError = "Docker engine is unavailable on this machine. Start Docker Desktop and refresh the dashboard.";
    } else {
      unavailableServerIds = [activeServer.id];
      const failedServerName = activeServer.name || activeServer.host || activeServer.id;
      activeServer = localServer;
      fallbackError = `Failed to connect to ${failedServerName}. Marked as [unavialable] and switched to local server.`;

      try {
        // Use cached Docker data for fallback local server
        const cachedData = await getCachedDockerData(activeServer, async () => {
          const [fetchedContainers, fetchedStats, fetchedHostInfo] = await Promise.all([
            deps.listContainers(activeServer),
            deps.listContainerStats(activeServer),
            deps.getHostInfo(activeServer),
          ]);
          return {
            containers: fetchedContainers,
            stats: fetchedStats,
            hostInfo: fetchedHostInfo,
          };
        });

        containers = cachedData.containers;
        containerStats = cachedData.stats;
        hostInfo = cachedData.hostInfo;
        cacheAge = cachedData.cacheAge;
      } catch (fallbackLocalError) {
        if (!isLocalDockerUnavailableError(fallbackLocalError)) {
          throw fallbackLocalError;
        }

        fallbackError = `${fallbackError} Docker engine is unavailable on this machine. Start Docker Desktop and refresh the dashboard.`;
      }
    }
  }

  setActiveServerSession(res, req, activeServer.id);

  const metricsWarning = "";
  const statsLookup = buildContainerStatsLookup(containerStats);
  const groupedContainers = groupContainersByComposeFile(containers, getServiceHost(activeServer), statsLookup);
  const serverMetrics = buildServerMetrics(hostInfo, containerStats, metricsWarning);
  const launcherTiles = buildLaunchpadTiles(containers, getServiceHost(activeServer));

  return {
    servers,
    defaultServerId,
    activeServer,
    unavailableServerIds,
    fallbackError,
    containers,
    groupedContainers,
    launcherTiles,
    serverMetrics,
    metricsWarning,
    cacheAge,
  };
}

export function createDashboardRouter(deps: AppDeps) {
  const router = Router();

  router.get("/", requireAuth, requirePermission(PERMISSIONS.CONTAINERS_VIEW), async (req, res) => {
    try {
      // For initial page load, just send empty data - Vue will fetch it
      const { servers, defaultServerId } = await listRemoteServers();
      const selectedFromSession = getActiveServerSessionId(req);
      const { server: activeServer } = await resolveServerByIdOrDefault(selectedFromSession);
      
      const can = getPermissionFlags(req.user);
      const { notice, error } = consumeFlashSession(res, req);

      res.render("dashboard", {
        user: req.user,
        can,
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
        csrfToken: req.csrfToken,
        notice: "",
        error: `Dashboard error: ${error.message}`,
        servers: [],
        activeServerId: "",
        defaultServerId: "local",
      });
    }
  });

  // API endpoint for auto-refresh (returns JSON)
  router.get("/api/dashboard", requireAuth, requirePermission(PERMISSIONS.CONTAINERS_VIEW), async (req, res) => {
    try {
      const dashboardData = await fetchDashboardData(req, res, deps);
      const can = getPermissionFlags(req.user);

      // Get pending actions for the active server
      const pendingActionsMap = getPendingActionsForServer(dashboardData.activeServer.id);
      const pendingActions: Record<string, { action: string; timestamp: number }> = {};
      for (const [containerId, pending] of pendingActionsMap.entries()) {
        pendingActions[containerId] = {
          action: pending.action,
          timestamp: pending.timestamp,
        };
      }

      res.json({
        success: true,
        data: {
          containers: dashboardData.containers,
          groupedContainers: dashboardData.groupedContainers,
          launcherTiles: dashboardData.launcherTiles,
          serverMetrics: dashboardData.serverMetrics,
          metricsWarning: dashboardData.metricsWarning,
          servers: dashboardData.servers,
          activeServerId: dashboardData.activeServer.id,
          defaultServerId: dashboardData.defaultServerId,
          unavailableServerIds: dashboardData.unavailableServerIds,
          cacheAge: dashboardData.cacheAge,
          pendingActions,
          timestamp: Date.now(),
        },
        permissions: can,
      });
    } catch (e) {
      const error = e as Error;
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  router.post(
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

        // Set pending action before executing
        setPendingAction(server.id, target.ID, "removing");
        
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

  router.post(
    "/containers/:containerId/start",
    requireAuth,
    ensureCsrf,
    requirePermission(PERMISSIONS.CONTAINERS_RESTART),
    async (req, res) => {
      try {
        const { containerId } = req.params;
        const { server } = await resolveServerByIdOrDefault(getActiveServerSessionId(req));
        
        // Get container to find its ID for pending action
        const containers = await deps.listContainers(server);
        const target = containers.find((container) => containerMatchesIdentifier(container, containerId));
        if (target) {
          setPendingAction(server.id, target.ID, "starting");
        }
        
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

  router.post(
    "/containers/:containerId/stop",
    requireAuth,
    ensureCsrf,
    requirePermission(PERMISSIONS.CONTAINERS_RESTART),
    async (req, res) => {
      try {
        const { containerId } = req.params;
        const { server } = await resolveServerByIdOrDefault(getActiveServerSessionId(req));
        
        // Get container to find its ID for pending action
        const containers = await deps.listContainers(server);
        const target = containers.find((container) => containerMatchesIdentifier(container, containerId));
        if (target) {
          setPendingAction(server.id, target.ID, "stopping");
        }
        
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

  router.post(
    "/containers/:containerId/restart",
    requireAuth,
    ensureCsrf,
    requirePermission(PERMISSIONS.CONTAINERS_RESTART),
    async (req, res) => {
      try {
        const { containerId } = req.params;
        const { server } = await resolveServerByIdOrDefault(getActiveServerSessionId(req));
        
        // Get container to find its ID for pending action
        const containers = await deps.listContainers(server);
        const target = containers.find((container) => containerMatchesIdentifier(container, containerId));
        if (target) {
          setPendingAction(server.id, target.ID, "restarting");
        }
        
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

  router.post(
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
            setPendingAction(server.id, target.ID, "removing");
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

  router.post(
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
        const containers = await deps.listContainers(server);

        for (const containerId of selectedContainerIds) {
          try {
            const target = containers.find((container) => containerMatchesIdentifier(container, containerId));
            if (target) {
              setPendingAction(server.id, target.ID, "starting");
            }
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

  router.post(
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
        const containers = await deps.listContainers(server);

        for (const containerId of selectedContainerIds) {
          try {
            const target = containers.find((container) => containerMatchesIdentifier(container, containerId));
            if (target) {
              setPendingAction(server.id, target.ID, "stopping");
            }
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

  router.post(
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
        const containers = await deps.listContainers(server);

        for (const containerId of selectedContainerIds) {
          try {
            const target = containers.find((container) => containerMatchesIdentifier(container, containerId));
            if (target) {
              setPendingAction(server.id, target.ID, "restarting");
            }
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

  router.post(
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

  return router;
}
