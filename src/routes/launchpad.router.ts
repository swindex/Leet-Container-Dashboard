import { Router } from "express";
import fs from "fs/promises";
import crypto from "crypto";
import path from "path";
import multer from "multer";
import {
  consumeFlashSession,
  ensureCsrf,
  getActiveServerSessionId,
  getPermissionFlags,
  requireAuth,
  requirePermission,
  setFlashSession,
} from "../lib/auth.js";
import { PERMISSIONS } from "../lib/rbac.js";
import { listRemoteServers, resolveServerByIdOrDefault } from "../lib/remoteServers.js";
import { listLaunchpadItems, updateLaunchpadItem, toggleLaunchpadItemVisibility, getLaunchpadItemById } from "../lib/launchpadItems.js";
import { getLaunchpadIconsUploadsPath } from "../lib/dashboardSettings.js";

function iconExtensionFromMimeType(mimeType: string): string | null {
  const normalized = (mimeType || "").toLowerCase();
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
  };
  return map[normalized] ?? null;
}

export function createLaunchpadRouter() {
  const router = Router();
  
  const launchpadIconsDir = getLaunchpadIconsUploadsPath();
  const iconUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 5 * 1024 * 1024, // 5MB
    },
  });

  router.get("/launchpad", requireAuth, requirePermission(PERMISSIONS.CONTAINERS_VIEW), async (req, res) => {
    try {
      const { servers, defaultServerId } = await listRemoteServers();
      const selectedFromSession = getActiveServerSessionId(req);
      const { server: activeServer } = await resolveServerByIdOrDefault(selectedFromSession);
      const can = getPermissionFlags(req.user);
      const { notice, error } = consumeFlashSession(res, req);

      res.render("launchpad", {
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
      res.status(500).render("launchpad", {
        user: req.user,
        can: getPermissionFlags(req.user),
        csrfToken: req.csrfToken,
        notice: "",
        error: `Launchpad error: ${error.message}`,
        servers: [],
        activeServerId: "",
        defaultServerId: "local",
      });
    }
  });

  router.get("/api/launchpad", requireAuth, requirePermission(PERMISSIONS.CONTAINERS_VIEW), async (req, res) => {
    try {
      const { servers, defaultServerId } = await listRemoteServers();
      const selectedFromSession = getActiveServerSessionId(req);
      const { server: activeServer } = await resolveServerByIdOrDefault(selectedFromSession);
      
      // Read launchpad items from file
      const allItems = await listLaunchpadItems();
      
      // Create a set of enabled server IDs for quick lookup
      const enabledServerIds = new Set(
        servers.filter(server => server.enabled).map(server => server.id)
      );
      
      // Filter items from all enabled servers
      const tiles = allItems
        .filter(item => 
          enabledServerIds.has(item.serverId)
        )
        .map(item => ({
          id: item.id,
          name: item.name,
          description: item.description || "",
          iconClass: item.icon,
          iconColorClass: item.iconColor,
          launchUrl: item.publicUrl || item.localUrl,
          localUrl: item.localUrl,
          publicUrl: item.publicUrl,
          hidden: item.hidden,
          status: item.status,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      
      res.json({
        success: true,
        data: {
          launchpadTiles: tiles,
          servers,
          activeServerId: activeServer.id,
          defaultServerId,
          unavailableServerIds: [],
        },
      });
    } catch (e) {
      const error = e as Error;
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  router.get("/api/launchpad/icons", requireAuth, requirePermission(PERMISSIONS.CONTAINERS_VIEW), async (req, res) => {
    try {
      await fs.mkdir(launchpadIconsDir, { recursive: true });
      const files = await fs.readdir(launchpadIconsDir);
      const iconFiles = files
        .filter(file => /\.(png|jpg|jpeg|svg|gif|webp)$/i.test(file))
        .map(file => ({
          filename: file,
          path: `/uploads/launchpad-icons/${file}`,
        }));
      
      res.json({
        success: true,
        data: { icons: iconFiles },
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
    "/launchpad/:id/update",
    requireAuth,
    requirePermission(PERMISSIONS.CONTAINERS_VIEW),
    iconUpload.single("iconFile"),
    ensureCsrf,
    async (req, res) => {
      try {
        const itemId = req.params.id;
        const item = await getLaunchpadItemById(itemId);
        
        if (!item) {
          throw new Error("Launchpad item not found");
        }

        let iconPath = item.icon;

        // Handle icon file upload
        if (req.file) {
          const extension = iconExtensionFromMimeType(req.file.mimetype);
          if (!extension) {
            throw new Error("Icon must be png, jpg, jpeg, svg, webp, or gif");
          }

          await fs.mkdir(launchpadIconsDir, { recursive: true });
          const filename = `icon-${Date.now()}-${crypto.randomUUID()}${extension}`;
          const targetPath = path.join(launchpadIconsDir, filename);
          await fs.writeFile(targetPath, req.file.buffer);
          iconPath = `/uploads/launchpad-icons/${filename}`;
        } else if (typeof req.body?.icon === "string" && req.body.icon) {
          // Use selected icon from dropdown
          iconPath = req.body.icon;
        }

        await updateLaunchpadItem(itemId, {
          name: typeof req.body?.name === "string" ? req.body.name : undefined,
          description: typeof req.body?.description === "string" ? req.body.description : undefined,
          publicUrl: typeof req.body?.publicUrl === "string" ? req.body.publicUrl : undefined,
          icon: iconPath,
          hidden: typeof req.body?.hidden === "string" ? req.body.hidden === "true" : undefined,
        });

        setFlashSession(res, req, { notice: "Launchpad item updated successfully" });
        res.redirect("/launchpad");
      } catch (error) {
        setFlashSession(res, req, { error: (error as Error).message || "Failed to update launchpad item" });
        res.redirect("/launchpad");
      }
    }
  );

  router.post(
    "/launchpad/:id/toggle-visibility",
    requireAuth,
    requirePermission(PERMISSIONS.CONTAINERS_VIEW),
    ensureCsrf,
    async (req, res) => {
      try {
        const itemId = req.params.id;
        const isHidden = await toggleLaunchpadItemVisibility(itemId);
        
        setFlashSession(res, req, { 
          notice: isHidden ? "Item hidden from launchpad" : "Item shown on launchpad" 
        });
        res.redirect("/launchpad");
      } catch (error) {
        setFlashSession(res, req, { error: (error as Error).message || "Failed to toggle visibility" });
        res.redirect("/launchpad");
      }
    }
  );

  return router;
}
