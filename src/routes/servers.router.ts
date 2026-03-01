import { Router } from "express";
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
import { PERMISSIONS } from "../lib/rbac.js";
import {
  addDefaultLocalServer,
  createRemoteServer,
  deleteRemoteServer,
  getRemoteServerById,
  listRemoteServers,
  resolveServerByIdOrDefault,
  setDefaultServer,
  updateRemoteServer,
} from "../lib/remoteServers.js";
import { toBooleanFormValue } from "../lib/routerHelpers.js";

export function createServersRouter() {
  const router = Router();

  router.get(
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

  router.post(
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

  router.post(
    "/servers/local/add",
    requireAuth,
    ensureCsrf,
    requirePermission(PERMISSIONS.SERVERS_MANAGE),
    async (req, res) => {
      try {
        await addDefaultLocalServer();
        setFlashSession(res, req, { notice: "Local server added successfully" });
        res.redirect("/servers");
      } catch (error) {
        setFlashSession(res, req, { error: (error as Error).message || "Failed to add local server" });
        res.redirect("/servers");
      }
    }
  );

  router.post(
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

        //setFlashSession(res, req, { notice: "Server switched successfully" });
        res.redirect("/");
      } catch (error) {
        setFlashSession(res, req, { error: (error as Error).message || "Failed to switch server" });
        res.redirect("/");
      }
    }
  );

  router.post(
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

        const { servers } = await listRemoteServers();
        if (servers.length) {
          const { server } = await resolveServerByIdOrDefault(getActiveServerSessionId(req));
          setActiveServerSession(res, req, server.id);
        }
        setFlashSession(res, req, { notice: "Server updated successfully" });
        res.redirect("/servers");
      } catch (error) {
        setFlashSession(res, req, { error: (error as Error).message || "Failed to update server" });
        res.redirect("/servers");
      }
    }
  );

  router.post(
    "/servers/:serverId/delete",
    requireAuth,
    ensureCsrf,
    requirePermission(PERMISSIONS.SERVERS_MANAGE),
    async (req, res) => {
      try {
        await deleteRemoteServer(req.params.serverId);
        const { servers } = await listRemoteServers();
        if (servers.length) {
          const { server } = await resolveServerByIdOrDefault(getActiveServerSessionId(req));
          setActiveServerSession(res, req, server.id);
        }
        setFlashSession(res, req, { notice: "Server removed successfully" });
        res.redirect("/servers");
      } catch (error) {
        setFlashSession(res, req, { error: (error as Error).message || "Failed to delete server" });
        res.redirect("/servers");
      }
    }
  );

  router.post(
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

  return router;
}
