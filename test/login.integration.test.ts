import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import request from "supertest";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { ROLES, type Role } from "../src/lib/rbac.js";
import { invalidateCache } from "../src/lib/dockerStatsCache.js";

describe("login page integration", () => {
  let usersFilePath = "";
  let remoteServersFilePath = "";
  let dashboardSettingsFilePath = "";
  let dashboardUploadsDir = "";
  let restoreUsersFileContent: string | null = null;
  let usersFileExisted = false;
  let restoreRemoteServersFile: string | undefined;
  let restoreDashboardSettingsFile: string | undefined;
  let restoreDashboardUploadsDir: string | undefined;
  let restoreCookieSecret: string | undefined;
  let restoreNodeEnv: string | undefined;

  const restartContainerMock = vi.fn(async (_containerId: string) => undefined);
  const removeContainerMock = vi.fn(async (_containerId: string) => undefined);
  const startContainerMock = vi.fn(async (_containerId: string) => undefined);
  const stopContainerMock = vi.fn(async (_containerId: string) => undefined);
  const restartHostMock = vi.fn(async () => undefined);

  beforeAll(async () => {
    restoreRemoteServersFile = process.env.REMOTE_SERVERS_FILE;
    restoreDashboardSettingsFile = process.env.DASHBOARD_SETTINGS_FILE;
    restoreDashboardUploadsDir = process.env.DASHBOARD_UPLOADS_DIR;
    restoreCookieSecret = process.env.COOKIE_SECRET;
    restoreNodeEnv = process.env.NODE_ENV;

    usersFilePath = path.resolve(process.cwd(), "data", "test", "users.json");
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
    ];

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "home-server-tests-"));
    remoteServersFilePath = path.join(tempDir, "remoteServers.json");
    dashboardSettingsFilePath = path.join(tempDir, "dashboardSettings.json");
    dashboardUploadsDir = path.join(tempDir, "uploads", "backgrounds");

    await fs.writeFile(
      usersFilePath,
      JSON.stringify({ users: testUsers }, null, 2),
      "utf-8"
    );

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

    process.env.REMOTE_SERVERS_FILE = remoteServersFilePath;
    process.env.DASHBOARD_SETTINGS_FILE = dashboardSettingsFilePath;
    process.env.DASHBOARD_UPLOADS_DIR = dashboardUploadsDir;
    process.env.COOKIE_SECRET = "integration-test-secret";
  });

  beforeEach(async () => {
    restartContainerMock.mockClear();
    removeContainerMock.mockClear();
    startContainerMock.mockClear();
    stopContainerMock.mockClear();
    restartHostMock.mockClear();
    invalidateCache();
  });

  afterAll(async () => {
    if (restoreRemoteServersFile === undefined) {
      delete process.env.REMOTE_SERVERS_FILE;
    } else {
      process.env.REMOTE_SERVERS_FILE = restoreRemoteServersFile;
    }

    if (restoreDashboardSettingsFile === undefined) {
      delete process.env.DASHBOARD_SETTINGS_FILE;
    } else {
      process.env.DASHBOARD_SETTINGS_FILE = restoreDashboardSettingsFile;
    }

    if (restoreDashboardUploadsDir === undefined) {
      delete process.env.DASHBOARD_UPLOADS_DIR;
    } else {
      process.env.DASHBOARD_UPLOADS_DIR = restoreDashboardUploadsDir;
    }

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

    if (dashboardSettingsFilePath) {
      await fs.rm(path.dirname(dashboardSettingsFilePath), { recursive: true, force: true });
    }
  });

  it("redirects unauthenticated users to login", async () => {
    const app = createApp({
      listContainers: async () => [],
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      restartHostMachine: restartHostMock,
    });

    const res = await request(app).get("/");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/login");
  });

  it("adds common security headers to responses", async () => {
    const app = createApp({
      listContainers: async () => [],
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      restartHostMachine: restartHostMock,
    });

    const res = await request(app).get("/login");
    expect(res.status).toBe(200);
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("auto-generates a cookie secret when not configured", async () => {
    delete process.env.COOKIE_SECRET;

    const app = createApp({
      listContainers: async () => [],
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      restartHostMachine: restartHostMock,
    });

    const res = await request(app).get("/login");
    expect(res.status).toBe(200);

    process.env.COOKIE_SECRET = "integration-test-secret";
  });

  it("bootstraps first login as admin when users database is empty", async () => {
    await fs.writeFile(usersFilePath, JSON.stringify({ users: [] }, null, 2), "utf-8");

    const app = createApp({
      listContainers: async () => [],
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      restartHostMachine: restartHostMock,
    });

    const agent = request.agent(app);
    const username = "first-admin-user";
    const password = "any-password-value";

    const loginPageRes = await agent.get("/login");
    expect(loginPageRes.status).toBe(200);
    expect(loginPageRes.text).toContain("Authenticate to access Leet Container Dashboard");
    expect(loginPageRes.text).toContain("No users found. You are about to create the OG admin account.");
    expect(loginPageRes.text).toContain("Create Admin");

    const loginRes = await agent.post("/login").type("form").send({ username, password });
    expect(loginRes.status).toBe(302);
    expect(loginRes.headers.location).toBe("/");

    const savedUsers = JSON.parse(await fs.readFile(usersFilePath, "utf-8")) as {
      users: Array<{ username: string; role: Role; active: boolean; passwordHash: string }>;
    };

    expect(savedUsers.users).toHaveLength(1);
    expect(savedUsers.users[0].username).toBe(username);
    expect(savedUsers.users[0].role).toBe(ROLES.ADMIN);
    expect(savedUsers.users[0].active).toBe(true);
    expect(savedUsers.users[0].passwordHash).not.toBe(password);
    expect(await bcrypt.compare(password, savedUsers.users[0].passwordHash)).toBe(true);
  });

  it("shows validation error when bootstrapping admin with invalid username", async () => {
    await fs.writeFile(usersFilePath, JSON.stringify({ users: [] }, null, 2), "utf-8");

    const app = createApp({
      listContainers: async () => [],
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      restartHostMachine: restartHostMock,
    });

    const agent = request.agent(app);

    const loginRes = await agent.post("/login").type("form").send({
      username: "ad@fffff.com",
      password: "ValidPassword123",
    });

    expect(loginRes.status).toBe(400);
    expect(loginRes.text).toContain("Username must contain only letters, numbers, underscores, dots, and hyphens");
    expect(loginRes.text).toContain("ad@fffff.com");
    expect(loginRes.text).toContain("No users found. You are about to create the OG admin account.");

    const savedUsers = JSON.parse(await fs.readFile(usersFilePath, "utf-8")) as { users: any[] };
    expect(savedUsers.users).toHaveLength(0);
  });

  it("shows validation error when bootstrapping admin with short password", async () => {
    await fs.writeFile(usersFilePath, JSON.stringify({ users: [] }, null, 2), "utf-8");

    const app = createApp({
      listContainers: async () => [],
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      restartHostMachine: restartHostMock,
    });

    const agent = request.agent(app);

    const loginRes = await agent.post("/login").type("form").send({
      username: "validuser",
      password: "short",
    });

    expect(loginRes.status).toBe(400);
    expect(loginRes.text).toContain("Password must be at least 8 characters long");
    expect(loginRes.text).toContain("validuser");
    expect(loginRes.text).toContain("No users found. You are about to create the OG admin account.");

    const savedUsers = JSON.parse(await fs.readFile(usersFilePath, "utf-8")) as { users: any[] };
    expect(savedUsers.users).toHaveLength(0);
  });
});
