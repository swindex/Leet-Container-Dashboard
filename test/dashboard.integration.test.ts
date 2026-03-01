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

type TestUser = {
  id: string;
  username: string;
  role: Role;
  password: string;
  passwordHash: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

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

describe("dashboard page integration - statically rendered content only", () => {
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
  const listContainerStatsMock = vi.fn(async () => []);
  const getHostInfoMock = vi.fn(async () => ({ NCPU: 8, MemTotal: 16 * 1024 * 1024 * 1024 }));
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
        username: "operator1",
        role: ROLES.OPERATOR,
        passwordHash: await bcrypt.hash("OperatorPassword#2026", 10),
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
    removeContainerMock.mockClear();
    startContainerMock.mockClear();
    stopContainerMock.mockClear();
    listContainerStatsMock.mockClear();
    getHostInfoMock.mockClear();
    restartHostMock.mockClear();
    invalidateCache();

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

  it("allows viewer to view dashboard static content, but shows permission warnings", async () => {
    const app = createApp({
      listContainers: async () => [
        {
          ID: "abc123",
          Names: "nginx",
          Image: "nginx:latest",
          Status: "Up 1 hour",
          Command: "",
          CreatedAt: "",
          Labels: "",
          LocalVolumes: "",
          Mounts: "",
          Networks: "",
          Ports: "",
          RunningFor: "",
          Size: "",
          State: "",
        },
      ],
      removeContainerById: removeContainerMock,
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      listContainerStats: listContainerStatsMock,
      getHostInfo: getHostInfoMock,
      restartHostMachine: restartHostMock,
    });

    const agent = request.agent(app);
    const dashboardRes = await loginAndGetDashboard(agent, "viewer1", "ViewerPassword#2026");

    expect(dashboardRes.text).toContain("Leet Container Dashboard");
    expect(dashboardRes.text).toContain("Selected:");
    expect(dashboardRes.text).toContain("Admin Permission Required");
  });



  it("shows user management access on dashboard only for admin", async () => {
    const app = createApp({
      listContainers: async () => [],
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      restartHostMachine: restartHostMock,
    });

    const adminAgent = request.agent(app);
    const adminDashboard = await loginAndGetDashboard(adminAgent, "admin1", "AdminPassword#2026");
    expect(adminDashboard.text).toContain("User Management");
    expect(adminDashboard.text).toContain("Manage users: <strong>Yes</strong>");

    const operatorAgent = request.agent(app);
    const operatorDashboard = await loginAndGetDashboard(operatorAgent, "operator1", "OperatorPassword#2026");
    expect(operatorDashboard.text).not.toContain("User Management");
    expect(operatorDashboard.text).toContain("Manage users: <strong>No</strong>");
  });

  it("renders server and container resource metrics API when docker stats are available", async () => {
    const app = createApp({
      listContainers: async () => [
        {
          ID: "res111222333",
          Names: "metrics-api",
          Image: "repo/metrics-api:latest",
          Status: "Up 3 minutes",
          Command: "",
          CreatedAt: "",
          Labels: "",
          LocalVolumes: "",
          Mounts: "",
          Networks: "",
          Ports: "",
          RunningFor: "",
          Size: "",
          State: "running",
        },
      ],
      listContainerStats: async () => [
        {
          BlockIO: "1.2MB / 512kB",
          CPUPerc: "2.35%",
          Container: "res111222333",
          ID: "res111222333",
          MemPerc: "4.2%",
          MemUsage: "128MiB / 2GiB",
          Name: "metrics-api",
          NetIO: "4.5MB / 2.1MB",
          PIDs: "15",
        },
      ],
      getHostInfo: async () => ({
        NCPU: 12,
        MemTotal: 8 * 1024 * 1024 * 1024,
      }),
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      restartHostMachine: restartHostMock,
    });

    const agent = request.agent(app);
    await loginAndGetDashboard(agent, "admin1", "AdminPassword#2026");

    const apiRes = await agent.get("/api/dashboard");
    expect(apiRes.status).toBe(200);
    const data = apiRes.body.data;

    expect(data.serverMetrics.cpuCores).toBe("12");
    expect(data.serverMetrics.totalMemory).toBe("8.00 GiB");
    expect(data.serverMetrics.monitoredContainers).toBe(1);

    const container = data.groupedContainers[0].containers.find((c: any) => c.Names === "metrics-api");
    expect(container).toBeDefined();
    expect(container.resourceCpu).toBe("2.35%");
    expect(container.resourceMemory).toBe("128MiB / 2GiB");
    expect(container.resourceNetIo).toBe("4.5MB / 2.1MB");
    expect(container.resourceBlockIo).toBe("1.2MB / 512kB");
  });

  it("prefers status-based uptime over stale RunningFor value", async () => {
    const app = createApp({
      listContainers: async () => [
        {
          ID: "upt111",
          Names: "uptime-check",
          Image: "repo/uptime-check:latest",
          Status: "Up 8 seconds",
          Command: "",
          CreatedAt: "",
          Labels: "",
          LocalVolumes: "",
          Mounts: "",
          Networks: "",
          Ports: "",
          RunningFor: "2 hours",
          Size: "",
          State: "running",
        },
      ],
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      listContainerStats: listContainerStatsMock,
      getHostInfo: getHostInfoMock,
      restartHostMachine: restartHostMock,
    });

    const agent = request.agent(app);
    await loginAndGetDashboard(agent, "admin1", "AdminPassword#2026");

    const apiRes = await agent.get("/api/dashboard");
    expect(apiRes.status).toBe(200);
    const data = apiRes.body.data;
    
    const container = data.containers.find((c: any) => c.Names === "uptime-check");
    expect(container).toBeDefined();
    expect(container.Status).toBe("Up 8 seconds");
    expect(container.RunningFor).toBe("2 hours");
  });
});

describe("container operations and dashboard settings visibility integration", () => {
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
  const listContainerStatsMock = vi.fn(async () => []);
  const getHostInfoMock = vi.fn(async () => ({ NCPU: 8, MemTotal: 16 * 1024 * 1024 * 1024 }));
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
    const testUsers: TestUser[] = [
      {
        id: crypto.randomUUID(),
        username: "viewer1",
        role: ROLES.VIEWER,
        password: "ViewerPassword#2026",
        passwordHash: await bcrypt.hash("ViewerPassword#2026", 10),
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: crypto.randomUUID(),
        username: "operator1",
        role: ROLES.OPERATOR,
        password: "OperatorPassword#2026",
        passwordHash: await bcrypt.hash("OperatorPassword#2026", 10),
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: crypto.randomUUID(),
        username: "admin1",
        role: ROLES.ADMIN,
        password: "AdminPassword#2026",
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
      JSON.stringify(
        {
          users: testUsers.map(({ password, ...user }) => user),
        },
        null,
        2
      ),
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
    listContainerStatsMock.mockClear();
    getHostInfoMock.mockClear();
    restartHostMock.mockClear();

    // Clear Docker stats cache between tests
    invalidateCache();

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

  it("allows viewer to view dashboard, but blocks restart commands", async () => {
    const app = createApp({
      listContainers: async () => [
        {
          ID: "abc123",
          Names: "nginx",
          Image: "nginx:latest",
          Status: "Up 1 hour",
          Command: "",
          CreatedAt: "",
          Labels: "",
          LocalVolumes: "",
          Mounts: "",
          Networks: "",
          Ports: "",
          RunningFor: "",
          Size: "",
          State: "",
        },
      ],
      removeContainerById: removeContainerMock,
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      restartHostMachine: restartHostMock,
    });

    const agent = request.agent(app);
    const dashboardRes = await loginAndGetDashboard(agent, "viewer1", "ViewerPassword#2026");

    expect(dashboardRes.text).toContain("Leet Container Dashboard");
    expect(dashboardRes.text).toContain("Selected:");
    expect(dashboardRes.text).toContain("Admin Permission Required");

    const csrf = extractCsrfToken(dashboardRes.text);
    const restartRes = await agent
      .post("/containers/restart")
      .type("form")
      .send({ _csrf: csrf, containers: ["nginx"] });

    expect(restartRes.status).toBe(403);
    expect(restartContainerMock).not.toHaveBeenCalled();

    const startRes = await agent
      .post("/containers/start")
      .type("form")
      .send({ _csrf: csrf, containers: ["nginx"] });
    expect(startRes.status).toBe(403);
    expect(startContainerMock).not.toHaveBeenCalled();

    const stopRes = await agent
      .post("/containers/stop")
      .type("form")
      .send({ _csrf: csrf, containers: ["nginx"] });
    expect(stopRes.status).toBe(403);
    expect(stopContainerMock).not.toHaveBeenCalled();

    const removeRes = await agent
      .post("/containers/remove")
      .type("form")
      .send({ _csrf: csrf, containers: ["nginx"] });
    expect(removeRes.status).toBe(403);
    expect(removeContainerMock).not.toHaveBeenCalled();
  });

  it("allows operator to remove stopped containers and skips running ones", async () => {
    const app = createApp({
      listContainers: async () => [
        {
          ID: "rm111",
          Names: "old-worker",
          Image: "repo/worker:latest",
          Status: "Exited (0) 3 minutes ago",
          Command: "",
          CreatedAt: "",
          Labels: "",
          LocalVolumes: "",
          Mounts: "",
          Networks: "",
          Ports: "",
          RunningFor: "",
          Size: "",
          State: "exited",
        },
        {
          ID: "run111",
          Names: "live-api",
          Image: "repo/api:latest",
          Status: "Up 9 minutes",
          Command: "",
          CreatedAt: "",
          Labels: "",
          LocalVolumes: "",
          Mounts: "",
          Networks: "",
          Ports: "",
          RunningFor: "",
          Size: "",
          State: "running",
        },
      ],
      removeContainerById: removeContainerMock,
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      restartHostMachine: restartHostMock,
    });

    const agent = request.agent(app);
    const dashboardRes = await loginAndGetDashboard(agent, "operator1", "OperatorPassword#2026");
    const csrf = extractCsrfToken(dashboardRes.text);

    const removeRes = await agent
      .post("/containers/remove")
      .type("form")
      .send({ _csrf: csrf, containers: ["old-worker", "live-api"] });

    expect(removeRes.status).toBe(302);
    expect(removeContainerMock).toHaveBeenCalledTimes(1);
    expect(removeContainerMock).toHaveBeenCalledWith(
      "old-worker",
      expect.objectContaining({
        id: "local",
        isLocal: true,
      })
    );
  });

  it("allows operator to restart containers but not host", async () => {
    const app = createApp({
      listContainers: async () => [
        {
          ID: "def456",
          Names: "api",
          Image: "my-api:latest",
          Status: "Up 2 hours",
          Command: "",
          CreatedAt: "",
          Labels: "",
          LocalVolumes: "",
          Mounts: "",
          Networks: "",
          Ports: "",
          RunningFor: "",
          Size: "",
          State: "",
        },
      ],
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      restartHostMachine: restartHostMock,
    });

    const agent = request.agent(app);
    const dashboardRes = await loginAndGetDashboard(agent, "operator1", "OperatorPassword#2026");

    expect(dashboardRes.text).toContain("Restart");
    expect(dashboardRes.text).toContain("Admin Permission Required");

    const csrf = extractCsrfToken(dashboardRes.text);

    const containerRestartRes = await agent
      .post("/containers/restart")
      .type("form")
      .send({ _csrf: csrf, containers: ["api"] });
    expect(containerRestartRes.status).toBe(302);
    expect(restartContainerMock).toHaveBeenCalledWith(
      "api",
      expect.objectContaining({
        id: "local",
        isLocal: true,
      })
    );

    const hostRestartRes = await agent
      .post("/host/restart")
      .type("form")
      .send({ _csrf: csrf });
    expect(hostRestartRes.status).toBe(403);
    expect(restartHostMock).not.toHaveBeenCalled();
  });

  it("restarts multiple selected containers in one request", async () => {
    const app = createApp({
      listContainers: async () => [
        {
          ID: "api111",
          Names: "api",
          Image: "repo/api:latest",
          Status: "Up 1 hour",
          Command: "",
          CreatedAt: "",
          Labels: "",
          LocalVolumes: "",
          Mounts: "",
          Networks: "",
          Ports: "",
          RunningFor: "",
          Size: "",
          State: "running",
        },
        {
          ID: "worker111",
          Names: "worker",
          Image: "repo/worker:latest",
          Status: "Up 1 hour",
          Command: "",
          CreatedAt: "",
          Labels: "",
          LocalVolumes: "",
          Mounts: "",
          Networks: "",
          Ports: "",
          RunningFor: "",
          Size: "",
          State: "running",
        },
      ],
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      restartHostMachine: restartHostMock,
    });

    const agent = request.agent(app);
    const dashboardRes = await loginAndGetDashboard(agent, "operator1", "OperatorPassword#2026");
    const csrf = extractCsrfToken(dashboardRes.text);

    const containerRestartRes = await agent
      .post("/containers/restart")
      .type("form")
      .send({ _csrf: csrf, containers: ["api", "worker"] });

    expect(containerRestartRes.status).toBe(302);
    expect(restartContainerMock).toHaveBeenCalledTimes(2);
    expect(restartContainerMock).toHaveBeenNthCalledWith(
      1,
      "api",
      expect.objectContaining({
        id: "local",
        isLocal: true,
      })
    );
    expect(restartContainerMock).toHaveBeenNthCalledWith(
      2,
      "worker",
      expect.objectContaining({
        id: "local",
        isLocal: true,
      })
    );
  });

  it("allows operator to start and stop selected containers", async () => {
    const app = createApp({
      listContainers: async () => [
        {
          ID: "start111",
          Names: "stopped-worker",
          Image: "repo/worker:latest",
          Status: "Exited (0) 1 minute ago",
          Command: "",
          CreatedAt: "",
          Labels: "",
          LocalVolumes: "",
          Mounts: "",
          Networks: "",
          Ports: "",
          RunningFor: "",
          Size: "",
          State: "exited",
        },
        {
          ID: "stop111",
          Names: "running-api",
          Image: "repo/api:latest",
          Status: "Up 5 minutes",
          Command: "",
          CreatedAt: "",
          Labels: "",
          LocalVolumes: "",
          Mounts: "",
          Networks: "",
          Ports: "",
          RunningFor: "",
          Size: "",
          State: "running",
        },
      ],
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      restartHostMachine: restartHostMock,
    });

    const agent = request.agent(app);
    const dashboardRes = await loginAndGetDashboard(agent, "operator1", "OperatorPassword#2026");
    const csrf = extractCsrfToken(dashboardRes.text);

    const startRes = await agent
      .post("/containers/start")
      .type("form")
      .send({ _csrf: csrf, containers: ["stopped-worker"] });
    expect(startRes.status).toBe(302);
    expect(startContainerMock).toHaveBeenCalledTimes(1);
    expect(startContainerMock).toHaveBeenCalledWith(
      "stopped-worker",
      expect.objectContaining({
        id: "local",
        isLocal: true,
      })
    );

    const stopRes = await agent
      .post("/containers/stop")
      .type("form")
      .send({ _csrf: csrf, containers: ["running-api"] });
    expect(stopRes.status).toBe(302);
    expect(stopContainerMock).toHaveBeenCalledTimes(1);
    expect(stopContainerMock).toHaveBeenCalledWith(
      "running-api",
      expect.objectContaining({
        id: "local",
        isLocal: true,
      })
    );
  });

  it("allows admin to restart host", async () => {
    const app = createApp({
      listContainers: async () => [],
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      restartHostMachine: restartHostMock,
    });

    const agent = request.agent(app);
    const dashboardRes = await loginAndGetDashboard(agent, "admin1", "AdminPassword#2026");
    expect(dashboardRes.text).toContain("Restart Host");

    const csrf = extractCsrfToken(dashboardRes.text);
    const hostRestartRes = await agent
      .post("/host/restart")
      .type("form")
      .send({ _csrf: csrf });

    expect(hostRestartRes.status).toBe(302);
    expect(restartHostMock).toHaveBeenCalledTimes(1);
  });

  it("hides server and container resources when both toggles are disabled", async () => {
    const app = createApp({
      listContainers: async () => [
        {
          ID: "hide111",
          Names: "hidden-metrics-api",
          Image: "repo/hidden-metrics-api:latest",
          Status: "Up 2 minutes",
          Command: "",
          CreatedAt: "",
          Labels: "",
          LocalVolumes: "",
          Mounts: "",
          Networks: "",
          Ports: "",
          RunningFor: "",
          Size: "",
          State: "running",
        },
      ],
      listContainerStats: async () => [
        {
          BlockIO: "1MB / 1MB",
          CPUPerc: "7.00%",
          Container: "hide111",
          ID: "hide111",
          MemPerc: "2.0%",
          MemUsage: "64MiB / 2GiB",
          Name: "hidden-metrics-api",
          NetIO: "2MB / 1MB",
          PIDs: "7",
        },
      ],
      getHostInfo: async () => ({
        NCPU: 16,
        MemTotal: 16 * 1024 * 1024 * 1024,
      }),
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
        hideAttributionFooter: "0",
        showContainerResources: "0",
        showServerResources: "0",
        showImageName: "on",
        showContainerHash: "on",
      });

    expect(saveRes.status).toBe(302);

    // Verify settings were saved correctly
    const savedSettings = JSON.parse(await fs.readFile(dashboardSettingsFilePath, "utf-8")) as {
      showContainerResources: boolean;
      showServerResources: boolean;
    };
    expect(savedSettings.showContainerResources).toBe(false);
    expect(savedSettings.showServerResources).toBe(false);

    // Verify the Vue template has conditional rendering based on these settings
    const dashboardRes = await agent.get("/");
    expect(dashboardRes.status).toBe(200);
    // Check that Vue template uses v-if="false" for server resources
    expect(dashboardRes.text).toContain('v-if="false"');
    // Confirm Vue template is present
    expect(dashboardRes.text).toContain("serverMetrics");
  });

  it("hides image name and container hash when both toggles are disabled", async () => {
    const app = createApp({
      listContainers: async () => [
        {
          ID: "imgname111222333",
          Names: "hidden-image-and-hash",
          Image: "repo/hidden-image-and-hash:latest",
          Status: "Up 2 minutes",
          Command: "",
          CreatedAt: "",
          Labels: "",
          LocalVolumes: "",
          Mounts: "",
          Networks: "",
          Ports: "",
          RunningFor: "",
          Size: "",
          State: "running",
        },
      ],
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
        hideAttributionFooter: "0",
        showContainerResources: "on",
        showServerResources: "on",
        showImageName: "0",
        showContainerHash: "0",
      });

    expect(saveRes.status).toBe(302);

    // Verify settings were saved correctly
    const savedSettings = JSON.parse(await fs.readFile(dashboardSettingsFilePath, "utf-8")) as {
      showImageName: boolean;
      showContainerHash: boolean;
    };
    expect(savedSettings.showImageName).toBe(false);
    expect(savedSettings.showContainerHash).toBe(false);

    // Verify Vue template has conditional rendering for these settings
    const dashboardRes = await agent.get("/");
    expect(dashboardRes.status).toBe(200);
    expect(dashboardRes.text).toContain(`v-if="false" class="text-muted block hash-text`);
    expect(dashboardRes.text).toContain(`v-if="false" class="text-muted block image-text`);
  });

  it("defaults resource visibility toggles to true for legacy settings files", async () => {
    await fs.writeFile(
      dashboardSettingsFilePath,
      JSON.stringify(
        {
          appTitle: "Legacy Title",
          appSlogan: "Legacy slogan",
          theme: "dark",
          backgroundImagePath: "",
        },
        null,
        2
      ),
      "utf-8"
    );

    const app = createApp({
      listContainers: async () => [
        {
          ID: "legacy111",
          Names: "legacy-api",
          Image: "repo/legacy-api:latest",
          Status: "Up 1 minute",
          Command: "",
          CreatedAt: "",
          Labels: "",
          LocalVolumes: "",
          Mounts: "",
          Networks: "",
          Ports: "",
          RunningFor: "",
          Size: "",
          State: "running",
        },
      ],
      listContainerStats: async () => [
        {
          BlockIO: "512kB / 512kB",
          CPUPerc: "1.50%",
          Container: "legacy111",
          ID: "legacy111",
          MemPerc: "1.0%",
          MemUsage: "32MiB / 2GiB",
          Name: "legacy-api",
          NetIO: "1MB / 512kB",
          PIDs: "6",
        },
      ],
      getHostInfo: async () => ({
        NCPU: 4,
        MemTotal: 4 * 1024 * 1024 * 1024,
      }),
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      restartHostMachine: restartHostMock,
    });

    const agent = request.agent(app);
    const dashboardRes = await loginAndGetDashboard(agent, "admin1", "AdminPassword#2026");
    expect(dashboardRes.text).toContain("Resource Consumption");
    expect(dashboardRes.text).toContain(">Resources</th>");

    const settingsRes = await agent.get("/settings");
    expect(settingsRes.status).toBe(200);
    expect(settingsRes.text).toContain('id="showContainerResources"');
    expect(settingsRes.text).toContain('name="showContainerResources"');
    expect(settingsRes.text).toContain('name="showServerResources"');
    expect(settingsRes.text).toContain('name="showImageName"');
    expect(settingsRes.text).toContain('name="showContainerHash"');
    expect(settingsRes.text).toContain('name="hideAttributionFooter"');

    const savedSettings = JSON.parse(await fs.readFile(dashboardSettingsFilePath, "utf-8")) as {
      hideAttributionFooter: boolean;
      showContainerResources: boolean;
      showServerResources: boolean;
      showImageName: boolean;
      showContainerHash: boolean;
    };
    expect(savedSettings.hideAttributionFooter).toBe(false);
    expect(savedSettings.showContainerResources).toBe(true);
    expect(savedSettings.showServerResources).toBe(true);
    expect(savedSettings.showImageName).toBe(true);
    expect(savedSettings.showContainerHash).toBe(true);
  });
});
