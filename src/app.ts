import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import cookieParser from "cookie-parser";
import {
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

function parseMessage(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.slice(0, 180);
}

function toBooleanFormValue(value: unknown): boolean {
  return value === "true" || value === "on" || value === "1";
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
  app.set("views", path.join(__dirname, "..", "views"));
  app.use("/public", express.static(path.join(__dirname, "..", "public")));
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
      const notice = parseMessage(req.query.notice);
      const error = parseMessage(req.query.error);

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

        res.redirect("/?notice=Server%20switched%20successfully");
      } catch (error) {
        res.redirect(`/?error=${encodeURIComponent((error as Error).message || "Failed to switch server")}`);
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
        res.redirect("/users?notice=User%20created%20successfully");
      } catch (error) {
        res.redirect(`/users?error=${encodeURIComponent((error as Error).message || "Failed to create user")}`);
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
        res.redirect("/users?notice=User%20disabled%20successfully");
      } catch (error) {
        res.redirect(`/users?error=${encodeURIComponent((error as Error).message || "Failed to disable user")}`);
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
        res.redirect("/users?notice=User%20enabled%20successfully");
      } catch (error) {
        res.redirect(`/users?error=${encodeURIComponent((error as Error).message || "Failed to enable user")}`);
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
        res.redirect("/users?notice=User%20removed%20successfully");
      } catch (error) {
        res.redirect(`/users?error=${encodeURIComponent((error as Error).message || "Failed to remove user")}`);
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
        const notice = parseMessage(req.query.notice);
        const error = parseMessage(req.query.error);

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
        const notice = parseMessage(req.query.notice);
        const error = parseMessage(req.query.error);

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
        res.redirect("/servers?notice=Server%20created%20successfully");
      } catch (error) {
        res.redirect(`/servers?error=${encodeURIComponent((error as Error).message || "Failed to create server")}`);
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
        res.redirect("/servers?notice=Server%20updated%20successfully");
      } catch (error) {
        res.redirect(`/servers?error=${encodeURIComponent((error as Error).message || "Failed to update server")}`);
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
        res.redirect("/servers?notice=Server%20removed%20successfully");
      } catch (error) {
        res.redirect(`/servers?error=${encodeURIComponent((error as Error).message || "Failed to delete server")}`);
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
        res.redirect("/servers?notice=Default%20server%20updated%20successfully");
      } catch (error) {
        res.redirect(`/servers?error=${encodeURIComponent((error as Error).message || "Failed to set default server")}`);
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

        res.redirect("/?notice=Container%20restarted%20successfully");
      } catch (error) {
        console.warn("AUDIT container_restart", {
          actor: req.user?.username,
          role: req.user?.role,
          target: req.params.containerId,
          at: new Date().toISOString(),
          result: "error",
          message: (error as Error).message,
        });

        res.redirect("/?error=Failed%20to%20restart%20container");
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

        res.redirect("/?notice=Host%20restart%20command%20issued");
      } catch (error) {
        console.warn("AUDIT host_restart", {
          actor: req.user?.username,
          role: req.user?.role,
          at: new Date().toISOString(),
          result: "error",
          message: (error as Error).message,
        });

        res.redirect("/?error=Failed%20to%20restart%20host");
      }
    }
  );

  return app;
}
