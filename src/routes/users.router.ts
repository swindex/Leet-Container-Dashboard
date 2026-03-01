import { Router } from "express";
import {
  consumeFlashSession,
  createManagedUser,
  deleteManagedUser,
  ensureCsrf,
  getPermissionFlags,
  listManagedUsers,
  requireAuth,
  requirePermission,
  setFlashSession,
  setManagedUserActiveStatus,
  updateManagedUser,
} from "../lib/auth.js";
import { PERMISSIONS, ROLES, type Role } from "../lib/rbac.js";

export function createUsersRouter() {
  const router = Router();

  router.get(
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

  router.post(
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

  router.post(
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

  router.post(
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

  router.post(
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

  router.post(
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

  return router;
}
