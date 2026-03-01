import { Router } from "express";
import fs from "fs/promises";
import crypto from "crypto";
import path from "path";
import multer from "multer";
import {
  consumeFlashSession,
  ensureCsrf,
  getPermissionFlags,
  requireAuth,
  requirePermission,
  setFlashSession,
} from "../lib/auth.js";
import { PERMISSIONS } from "../lib/rbac.js";
import {
  getDashboardBackgroundUploadsPath,
  updateDashboardSettings,
  type DashboardSettings,
  type DashboardTheme,
} from "../lib/dashboardSettings.js";
import {
  backgroundExtensionFromMimeType,
  toBooleanFormValue,
} from "../lib/routerHelpers.js";

function resolveDashboardTheme(value: unknown): DashboardTheme {
  return value === "light" ? "light" : "dark";
}

export function createSettingsRouter() {
  const router = Router();
  
  const dashboardUploadsDir = getDashboardBackgroundUploadsPath();
  const dashboardUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 10 * 1024 * 1024,
    },
  });

  router.get(
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

  router.post(
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
          hideAttributionFooter: toBooleanFormValue(req.body?.hideAttributionFooter, false),
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

  return router;
}
