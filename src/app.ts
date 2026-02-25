import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import cookieParser from "cookie-parser";
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
  deleteManagedUser,
} from "./lib/auth.js";
import {
  listRunningContainers,
  restartContainer,
  type DockerContainer,
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type AppDeps = {
  listContainers: (server?: DockerTargetServer) => Promise<DockerContainer[]>;
  restartContainerById: (containerIdOrName: string, server?: DockerTargetServer) => Promise<void>;
  restartHostMachine: typeof restartHost;
};

type DashboardContainerGroup = {
  key: string;
  title: string;
  detail: string;
  containers: DockerContainer[];
};

type ResolvedComposeGroup = {
  key: string;
  title: string;
  detail: string;
};

const defaultDeps: AppDeps = {
  listContainers: listRunningContainers,
  restartContainerById: restartContainer,
  restartHostMachine: restartHost,
};

function toBooleanFormValue(value: unknown): boolean {
  return value === "true" || value === "on" || value === "1";
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
    const title = getBaseNameFromPath(workingDir) || getBaseNameFromPath(configFiles) || "Compose Stack";
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

function groupContainersByComposeFile(containers: DockerContainer[]): DashboardContainerGroup[] {
  const grouped = new Map<string, DashboardContainerGroup>();

  for (const container of containers) {
    const group = resolveComposeGroup(container);
    const existing = grouped.get(group.key);
    if (existing) {
      existing.containers.push(container);
    } else {
      grouped.set(group.key, {
        key: group.key,
        title: group.title,
        detail: group.detail,
        containers: [container],
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

  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "views"));
  app.use("/public", express.static(path.join(__dirname, "public")));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser(process.env.COOKIE_SECRET || "dev-secret"));

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
      const groupedContainers = groupContainersByComposeFile(containers);
      const can = getPermissionFlags(req.user);
      const { notice, error } = consumeFlashSession(res, req);

      res.render("dashboard", {
        user: req.user,
        can,
        containers,
        groupedContainers,
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
    "/containers/restart",
    requireAuth,
    ensureCsrf,
    requirePermission(PERMISSIONS.CONTAINERS_RESTART),
    async (req, res) => {
      const selectedContainerIds = [
        ...toStringArray(req.body?.containers),
        ...toStringArray(req.body?.["containers[]"]),
      ]
        .map((value) => value.trim())
        .filter(Boolean)
        .filter((value, index, array) => array.indexOf(value) === index);

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
