import { Router } from "express";
import crypto from "crypto";
import path from "path";
import multer from "multer";
import * as fs from "../lib/fileSystem.js";
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
} from "../lib/dashboardSettings.js";
import {
  backgroundExtensionFromMimeType,
} from "../lib/routerHelpers.js";
import { updateSettingsSchema, validateOrThrow } from "../lib/validation.js";

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
        // Validate settings using Joi schema
        const validatedData = validateOrThrow<DashboardSettings>(updateSettingsSchema, req.body);

        const patch: Partial<DashboardSettings> = {
          appTitle: validatedData.appTitle,
          appSlogan: validatedData.appSlogan,
          theme: validatedData.theme,
          hideAttributionFooter: validatedData.hideAttributionFooter,
          showContainerResources: validatedData.showContainerResources,
          showServerResources: validatedData.showServerResources,
          showImageName: validatedData.showImageName,
          showContainerHash: validatedData.showContainerHash,
          dashboardRefreshInterval: validatedData.dashboardRefreshInterval,
          defaultViewPage: validatedData.defaultViewPage,
        };

        // Handle file upload separately
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
