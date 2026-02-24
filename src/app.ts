import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import cookieParser from "cookie-parser";
import {
  createManagedUser,
  ensureCsrf,
  getPermissionFlags,
  handleLogin,
  listManagedUsers,
  logout,
  requireAuth,
  requirePermission,
  setManagedUserActiveStatus,
  deleteManagedUser,
} from "./lib/auth.js";
import { listRunningContainers, restartContainer } from "./lib/dockerCli.js";
import { PERMISSIONS, ROLES, type Role } from "./lib/rbac.js";
import { restartHost } from "./lib/systemCli.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type AppDeps = {
  listContainers: typeof listRunningContainers;
  restartContainerById: typeof restartContainer;
  restartHostMachine: typeof restartHost;
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
      const containers = await deps.listContainers();
      const can = getPermissionFlags(req.user);
      const notice = parseMessage(req.query.notice);
      const error = parseMessage(req.query.error);

      res.render("dashboard", {
        user: req.user,
        can,
        containers,
        csrfToken: req.csrfToken,
        notice,
        error,
      });
    } catch (e) {
      const error = e as Error;
      res.status(500).render("dashboard", {
        user: req.user,
        can: getPermissionFlags(req.user),
        containers: [],
        csrfToken: req.csrfToken,
        notice: "",
        error: `Docker error: ${error.message}`,
      });
    }
  });

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

  app.post(
    "/containers/:containerId/restart",
    requireAuth,
    ensureCsrf,
    requirePermission(PERMISSIONS.CONTAINERS_RESTART),
    async (req, res) => {
      try {
        const { containerId } = req.params;
        await deps.restartContainerById(containerId);

        console.info("AUDIT container_restart", {
          actor: req.user?.username,
          role: req.user?.role,
          target: containerId,
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
