import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import request from "supertest";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { ROLES } from "../src/lib/rbac.js";
import { invalidateCache } from "../src/lib/dockerStatsCache.js";
import { resolveDataPath } from "../src/lib/dataPaths.js";

function extractCsrfToken(html: string): string {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  if (!match) {
    throw new Error("Could not extract CSRF token from response HTML");
  }
  return match[1];
}

async function loginAndGetDashboard(agent: any, username: string, password: string) {
  const loginRes = await agent.post("/login").type("form").send({ username, password });
  expect(loginRes.status).toBe(302);
  expect(loginRes.headers.location).toBe("/");

  const dashboardRes = await agent.get("/");
  expect(dashboardRes.status).toBe(200);
  return dashboardRes;
}

describe("dashboard settings page integration", () => {
  let usersFilePath = "";
  let remoteServersFilePath = "";
  let dashboardSettingsFilePath = "";
  let dashboardUploadsDir = "";
  let restoreUsersFileContent: string | null = null;
  let usersFileExisted = false;
  let restoreCookieSecret: string | undefined;
  let restoreNodeEnv: string | undefined;

  const restartContainerMock = vi.fn(async (_containerId: string) => undefined);
  const startContainerMock = vi.fn(async (_containerId: string) => undefined);
  const stopContainerMock = vi.fn(async (_containerId: string) => undefined);
  const restartHostMock = vi.fn(async () => undefined);

  beforeAll(async () => {
    restoreCookieSecret = process.env.COOKIE_SECRET;
    restoreNodeEnv = process.env.NODE_ENV;

    usersFilePath = resolveDataPath("users.json");
    remoteServersFilePath = resolveDataPath("remoteServers.json");
    dashboardSettingsFilePath = resolveDataPath("dashboardSettings.json");
    dashboardUploadsDir = resolveDataPath("uploads", "backgrounds");

    await fs.mkdir(path.dirname(usersFilePath), { recursive: true });
    try {
      restoreUsersFileContent = await fs.readFile(usersFilePath, "utf-8");
      usersFileExisted = true;
    } catch {
      restoreUsersFileContent = null;
      usersFileExisted = false;
    }

    const now = new Date().toISOString();
    const testUsers = [
      {
        id: crypto.randomUUID(),
        username: "viewer1",
        role: ROLES.VIEWER,
        passwordHash: await bcrypt.hash("ViewerPassword#2026", 10),
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: crypto.randomUUID(),
        username: "admin1",
        role: ROLES.ADMIN,
        passwordHash: await bcrypt.hash("AdminPassword#2026", 10),
        active: true,
        createdAt: now,
        updatedAt: now,
      },
    ];

    await fs.writeFile(usersFilePath, JSON.stringify({ users: testUsers }, null, 2), "utf-8");
    await fs.writeFile(
      remoteServersFilePath,
      JSON.stringify(
        {
          defaultServerId: "local",
          servers: [
            {
              id: "local",
              name: "Local Server",
              host: "localhost",
              username: "",
              password: "",
              enabled: true,
              isLocal: true,
            },
          ],
        },
        null,
        2
      ),
      "utf-8"
    );

    await fs.mkdir(path.dirname(dashboardSettingsFilePath), { recursive: true });
    await fs.mkdir(dashboardUploadsDir, { recursive: true });

    process.env.COOKIE_SECRET = "integration-test-secret";
  });

  beforeEach(async () => {
    restartContainerMock.mockClear();
    startContainerMock.mockClear();
    stopContainerMock.mockClear();
    restartHostMock.mockClear();
    invalidateCache();
  });

  afterAll(async () => {
    if (usersFileExisted) {
      await fs.writeFile(usersFilePath, restoreUsersFileContent ?? "", "utf-8");
    } else {
      await fs.rm(usersFilePath, { force: true });
    }

    if (restoreCookieSecret === undefined) {
      delete process.env.COOKIE_SECRET;
    } else {
      process.env.COOKIE_SECRET = restoreCookieSecret;
    }

    if (restoreNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = restoreNodeEnv;
    }
  });

  it("allows admin to access dashboard settings and blocks non-admin", async () => {
    const app = createApp({
      listContainers: async () => [],
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      restartHostMachine: restartHostMock,
    });

    const adminAgent = request.agent(app);
    await loginAndGetDashboard(adminAgent, "admin1", "AdminPassword#2026");
    const settingsRes = await adminAgent.get("/settings");
    expect(settingsRes.status).toBe(200);
    expect(settingsRes.text).toContain("Dashboard Settings");

    const viewerAgent = request.agent(app);
    await loginAndGetDashboard(viewerAgent, "viewer1", "ViewerPassword#2026");
    const forbiddenRes = await viewerAgent.get("/settings");
    expect(forbiddenRes.status).toBe(403);
  });

  it("allows admin to save dashboard settings to json file", async () => {
    const app = createApp({
      listContainers: async () => [],
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      restartHostMachine: restartHostMock,
    });

    const agent = request.agent(app);
    await loginAndGetDashboard(agent, "admin1", "AdminPassword#2026");
    const settingsPage = await agent.get("/settings");
    expect(settingsPage.status).toBe(200);
    const csrf = extractCsrfToken(settingsPage.text);

    const saveRes = await agent
      .post("/settings")
      .type("form")
      .send({
        _csrf: csrf,
        appTitle: "Custom Title",
        appSlogan: "Custom slogan",
        theme: "light",
        hideAttributionFooter: "on",
        showContainerResources: "on",
        showServerResources: "on",
        showImageName: "on",
        showContainerHash: "on",
      });

    expect(saveRes.status).toBe(302);
    expect(saveRes.headers.location).toBe("/settings");

    const savedSettings = JSON.parse(await fs.readFile(dashboardSettingsFilePath, "utf-8"));

    expect(savedSettings.appTitle).toBe("Custom Title");
    expect(savedSettings.appSlogan).toBe("Custom slogan");
    expect(savedSettings.theme).toBe("light");
    expect(savedSettings.hideAttributionFooter).toBe(true);
    expect(savedSettings.showContainerResources).toBe(true);
    expect(savedSettings.showServerResources).toBe(true);
    expect(savedSettings.showImageName).toBe(true);
    expect(savedSettings.showContainerHash).toBe(true);

    const dashboardRes = await agent.get("/");
    expect(dashboardRes.status).toBe(200);
    expect(dashboardRes.text).toContain("Custom Title");
    expect(dashboardRes.text).toContain("Custom slogan");
  });

  it("hides attribution footer when setting is enabled", async () => {
    const app = createApp({
      listContainers: async () => [],
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      restartHostMachine: restartHostMock,
    });

    const agent = request.agent(app);
    await loginAndGetDashboard(agent, "admin1", "AdminPassword#2026");
    const settingsPage = await agent.get("/settings");
    const csrf = extractCsrfToken(settingsPage.text);

    const saveRes = await agent
      .post("/settings")
      .type("form")
      .send({
        _csrf: csrf,
        appTitle: "Leet Container Dashboard",
        appSlogan: "Monitor and control containers on your network.",
        theme: "dark",
        hideAttributionFooter: "on",
        showContainerResources: "on",
        showServerResources: "on",
        showImageName: "on",
        showContainerHash: "on",
      });

    expect(saveRes.status).toBe(302);

    const dashboardRes = await agent.get("/");
    expect(dashboardRes.status).toBe(200);
    expect(dashboardRes.text).not.toContain("github.com/swindex/Leet-Container-Dashboard");
  });

  it("allows admin to upload dashboard background image", async () => {
    const app = createApp({
      listContainers: async () => [],
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      restartHostMachine: restartHostMock,
    });

    const agent = request.agent(app);
    await loginAndGetDashboard(agent, "admin1", "AdminPassword#2026");
    const settingsPage = await agent.get("/settings");
    const csrf = extractCsrfToken(settingsPage.text);

    const pngBuffer = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
      0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
      0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);

    const uploadRes = await agent
      .post("/settings")
      .field("_csrf", csrf)
      .field("appTitle", "Leet Container Dashboard")
      .field("appSlogan", "Monitor and control containers on your network.")
      .field("theme", "dark")
      .attach("backgroundImage", pngBuffer, {
        filename: "background.png",
        contentType: "image/png",
      });

    expect(uploadRes.status).toBe(302);
    expect(uploadRes.headers.location).toBe("/settings");

    const savedSettings = JSON.parse(await fs.readFile(dashboardSettingsFilePath, "utf-8"));
    expect(savedSettings.backgroundImagePath).toMatch(/^\/uploads\/backgrounds\/bg-/);

    const uploadedFile = path.join(dashboardUploadsDir, path.basename(savedSettings.backgroundImagePath));
    const fileStat = await fs.stat(uploadedFile);
    expect(fileStat.isFile()).toBe(true);
  });
});
