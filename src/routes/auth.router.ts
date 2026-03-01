import { Router } from "express";
import {
  ensureCsrf,
  handleLogin,
  isBootstrapAdminMode,
  logout,
  requireAuth,
} from "../lib/auth.js";

export function createAuthRouter() {
  const router = Router();

  router.get("/login", async (_req, res, next) => {
    try {
      const isBootstrapMode = await isBootstrapAdminMode();
      res.render("login", { error: "", username: "", isBootstrapMode });
    } catch (err) {
      next(err);
    }
  });

  router.post("/login", async (req, res, next) => {
    try {
      await handleLogin(req, res);
    } catch (err) {
      next(err);
    }
  });

  router.post("/logout", requireAuth, ensureCsrf, logout);

  return router;
}
