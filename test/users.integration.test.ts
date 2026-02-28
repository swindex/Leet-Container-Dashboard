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

async function readUsersFromFile(usersFilePath: string): Promise<Array<{ id: string; username: string; role: Role; active: boolean }>> {
  const parsed = JSON.parse(await fs.readFile(usersFilePath, "utf-8")) as {
    users: Array<{ id: string; username: string; role: Role; active: boolean }>;
  };
  return parsed.users;
}

describe("user management page integration", () => {
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

  it("allows admin to access users screen and blocks non-admin", async () => {
    const app = createApp({
      listContainers: async () => [],
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      restartHostMachine: restartHostMock,
    });

    const adminAgent = request.agent(app);
    await loginAndGetDashboard(adminAgent, "admin1", "AdminPassword#2026");
    const usersRes = await adminAgent.get("/users");
    expect(usersRes.status).toBe(200);
    expect(usersRes.text).toContain("User Management");
    expect(usersRes.text).toContain("Add User");

    const viewerAgent = request.agent(app);
    await loginAndGetDashboard(viewerAgent, "viewer1", "ViewerPassword#2026");
    const forbiddenRes = await viewerAgent.get("/users");
    expect(forbiddenRes.status).toBe(403);
  });

  it("allows admin to add, disable/enable, and remove users", async () => {
    const app = createApp({
      listContainers: async () => [],
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      restartHostMachine: restartHostMock,
    });

    const agent = request.agent(app);
    const dashboardRes = await loginAndGetDashboard(agent, "admin1", "AdminPassword#2026");
    const csrf = extractCsrfToken(dashboardRes.text);

    const createRes = await agent.post("/users").type("form").send({
      _csrf: csrf,
      username: "temp-user-1",
      password: "TempPassword#2026",
      role: ROLES.OPERATOR,
    });
    expect(createRes.status).toBe(302);
    expect(createRes.headers.location).toBe("/users");

    const usersAfterCreateRes = await agent.get("/users");
    expect(usersAfterCreateRes.status).toBe(200);
    expect(usersAfterCreateRes.text).toContain("User created successfully");

    let users = await readUsersFromFile(usersFilePath);
    const createdUser = users.find((u) => u.username === "temp-user-1");
    expect(createdUser).toBeDefined();
    expect(createdUser?.active).toBe(true);
    expect(createdUser?.role).toBe(ROLES.OPERATOR);

    const disableRes = await agent
      .post(`/users/${encodeURIComponent(createdUser!.id)}/disable`)
      .type("form")
      .send({ _csrf: csrf });
    expect(disableRes.status).toBe(302);

    users = await readUsersFromFile(usersFilePath);
    expect(users.find((u) => u.id === createdUser!.id)?.active).toBe(false);

    const enableRes = await agent
      .post(`/users/${encodeURIComponent(createdUser!.id)}/enable`)
      .type("form")
      .send({ _csrf: csrf });
    expect(enableRes.status).toBe(302);

    users = await readUsersFromFile(usersFilePath);
    expect(users.find((u) => u.id === createdUser!.id)?.active).toBe(true);

    const deleteRes = await agent
      .post(`/users/${encodeURIComponent(createdUser!.id)}/delete`)
      .type("form")
      .send({ _csrf: csrf });
    expect(deleteRes.status).toBe(302);

    users = await readUsersFromFile(usersFilePath);
    expect(users.find((u) => u.id === createdUser!.id)).toBeUndefined();
  });

  it("blocks admin self-disable and self-delete", async () => {
    const app = createApp({
      listContainers: async () => [],
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      restartHostMachine: restartHostMock,
    });

    const agent = request.agent(app);
    const dashboardRes = await loginAndGetDashboard(agent, "admin1", "AdminPassword#2026");
    const csrf = extractCsrfToken(dashboardRes.text);

    const users = await readUsersFromFile(usersFilePath);
    const admin = users.find((u) => u.username === "admin1");
    expect(admin).toBeDefined();

    const disableRes = await agent
      .post(`/users/${encodeURIComponent(admin!.id)}/disable`)
      .type("form")
      .send({ _csrf: csrf });
    expect(disableRes.status).toBe(302);
    expect(disableRes.headers.location).toBe("/users");

    const usersAfterDisableRes = await agent.get("/users");
    expect(usersAfterDisableRes.status).toBe(200);
    expect(usersAfterDisableRes.text).toContain("You cannot disable your own account");

    const deleteRes = await agent
      .post(`/users/${encodeURIComponent(admin!.id)}/delete`)
      .type("form")
      .send({ _csrf: csrf });
    expect(deleteRes.status).toBe(302);
    expect(deleteRes.headers.location).toBe("/users");

    const usersAfterDeleteRes = await agent.get("/users");
    expect(usersAfterDeleteRes.status).toBe(200);
    expect(usersAfterDeleteRes.text).toContain("You cannot delete your own account");
  });

  it("blocks disabling/deleting the original admin and hides those actions in UI", async () => {
    const app = createApp({
      listContainers: async () => [],
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      restartHostMachine: restartHostMock,
    });

    const agent = request.agent(app);
    const dashboardRes = await loginAndGetDashboard(agent, "admin1", "AdminPassword#2026");
    const csrf = extractCsrfToken(dashboardRes.text);

    const createSecondAdminRes = await agent.post("/users").type("form").send({
      _csrf: csrf,
      username: "admin2",
      password: "Admin2Password#2026",
      role: ROLES.ADMIN,
    });
    expect(createSecondAdminRes.status).toBe(302);

    const usersBefore = await readUsersFromFile(usersFilePath);
    const originalAdmin = usersBefore.find((u) => u.username === "admin1");
    const secondAdmin = usersBefore.find((u) => u.username === "admin2");
    expect(originalAdmin).toBeDefined();
    expect(secondAdmin).toBeDefined();

    const usersPage = await agent.get("/users");
    expect(usersPage.status).toBe(200);
    expect(usersPage.text).toContain("Protected account");
    expect(usersPage.text).not.toContain(`/users/${encodeURIComponent(originalAdmin!.id)}/disable`);
    expect(usersPage.text).not.toContain(`/users/${encodeURIComponent(originalAdmin!.id)}/delete`);
    expect(usersPage.text).toContain(`/users/${encodeURIComponent(secondAdmin!.id)}/disable`);

    const secondAdminAgent = request.agent(app);
    await loginAndGetDashboard(secondAdminAgent, "admin2", "Admin2Password#2026");
    const secondAdminUsersPage = await secondAdminAgent.get("/users");
    const secondAdminCsrf = extractCsrfToken(secondAdminUsersPage.text);

    const disableOriginalRes = await secondAdminAgent
      .post(`/users/${encodeURIComponent(originalAdmin!.id)}/disable`)
      .type("form")
      .send({ _csrf: secondAdminCsrf });
    expect(disableOriginalRes.status).toBe(302);
    expect(disableOriginalRes.headers.location).toBe("/users");

    const usersAfterDisableOriginalRes = await secondAdminAgent.get("/users");
    expect(usersAfterDisableOriginalRes.status).toBe(200);
    expect(usersAfterDisableOriginalRes.text).toContain("Cannot disable the original admin");

    const deleteOriginalRes = await secondAdminAgent
      .post(`/users/${encodeURIComponent(originalAdmin!.id)}/delete`)
      .type("form")
      .send({ _csrf: secondAdminCsrf });
    expect(deleteOriginalRes.status).toBe(302);
    expect(deleteOriginalRes.headers.location).toBe("/users");

    const usersAfterDeleteOriginalRes = await secondAdminAgent.get("/users");
    expect(usersAfterDeleteOriginalRes.status).toBe(200);
    expect(usersAfterDeleteOriginalRes.text).toContain("Cannot delete the original admin");

    const usersAfter = await readUsersFromFile(usersFilePath);
    expect(usersAfter.find((u) => u.id === originalAdmin!.id)?.active).toBe(true);
    expect(usersAfter.find((u) => u.id === originalAdmin!.id)).toBeDefined();
  });
});
