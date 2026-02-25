import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import request from "supertest";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { ROLES, type Role } from "../src/lib/rbac.js";

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

async function loginAndGetDashboard(agent: request.SuperAgentTest, username: string, password: string) {
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

describe("home server dashboard integration", () => {
  let usersFilePath = "";
  let dashboardSettingsFilePath = "";
  let dashboardUploadsDir = "";
  let restoreUsersFileContent: string | null = null;
  let usersFileExisted = false;
  let restoreDashboardSettingsFile: string | undefined;
  let restoreDashboardUploadsDir: string | undefined;
  let restoreCookieSecret: string | undefined;

  const restartContainerMock = vi.fn(async (_containerId: string) => undefined);
  const removeContainerMock = vi.fn(async (_containerId: string) => undefined);
  const startContainerMock = vi.fn(async (_containerId: string) => undefined);
  const stopContainerMock = vi.fn(async (_containerId: string) => undefined);
  const listContainerStatsMock = vi.fn(async () => []);
  const getHostInfoMock = vi.fn(async () => ({ NCPU: 8, MemTotal: 16 * 1024 * 1024 * 1024 }));
  const restartHostMock = vi.fn(async () => undefined);

  beforeAll(async () => {
    restoreDashboardSettingsFile = process.env.DASHBOARD_SETTINGS_FILE;
    restoreDashboardUploadsDir = process.env.DASHBOARD_UPLOADS_DIR;
    restoreCookieSecret = process.env.COOKIE_SECRET;

    usersFilePath = path.resolve(process.cwd(), "data", "users.test.json");
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

    process.env.DASHBOARD_SETTINGS_FILE = dashboardSettingsFilePath;
    process.env.DASHBOARD_UPLOADS_DIR = dashboardUploadsDir;
    process.env.COOKIE_SECRET = "integration-test-secret";
  });

  beforeEach(() => {
    restartContainerMock.mockClear();
    removeContainerMock.mockClear();
    startContainerMock.mockClear();
    stopContainerMock.mockClear();
    listContainerStatsMock.mockClear();
    getHostInfoMock.mockClear();
    restartHostMock.mockClear();
  });

  afterAll(async () => {
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
    const dashboardRes = await loginAndGetDashboard(agent, "admin1", "AdminPassword#2026");

    expect(dashboardRes.text).toContain("uptime-check");
    expect(dashboardRes.text).toContain("8 seconds");
    expect(dashboardRes.text).not.toContain(">2 hours<");
  });

  it("renders server and container resource metrics when docker stats are available", async () => {
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
    const dashboardRes = await loginAndGetDashboard(agent, "admin1", "AdminPassword#2026");

    expect(dashboardRes.text).toContain("Resource Consumption");
    expect(dashboardRes.text).toContain("CPU Cores");
    expect(dashboardRes.text).toContain(">12<");
    expect(dashboardRes.text).toContain("Total Memory");
    expect(dashboardRes.text).toContain("8.00 GiB");
    expect(dashboardRes.text).toContain("metrics-api");
    expect(dashboardRes.text).toContain("2.35%");
    expect(dashboardRes.text).toContain("128MiB / 2GiB");
    expect(dashboardRes.text).toContain("4.5MB / 2.1MB");
    expect(dashboardRes.text).toContain("1.2MB / 512kB");
  });

  it("shows metrics warning when docker stats collection fails", async () => {
    const app = createApp({
      listContainers: async () => [
        {
          ID: "warn111",
          Names: "warn-api",
          Image: "repo/warn-api:latest",
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
      listContainerStats: async () => {
        throw new Error("stats unavailable");
      },
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

    expect(dashboardRes.text).toContain("Resource metrics are temporarily unavailable for this server.");
    expect(dashboardRes.text).toContain("warn-api");
    expect(dashboardRes.text).toContain("<th class=\"resource-desktop-col\">Resources</th>");
    expect(dashboardRes.text).toContain("<strong>CPU</strong> -");
    expect(dashboardRes.text).toContain("<strong>Memory</strong> -");
    expect(dashboardRes.text).toContain("<strong>Net</strong> -");
    expect(dashboardRes.text).toContain("<strong>Disk</strong> -");
  });

  it("shows stopped status label for exited containers instead of exit code", async () => {
    const app = createApp({
      listContainers: async () => [
        {
          ID: "stoplbl111",
          Names: "stopped-by-test",
          Image: "repo/stopped:latest",
          Status: "Exited (0) 2 minutes ago",
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
          ID: "stopoom111",
          Names: "stopped-oom",
          Image: "repo/stopped-oom:latest",
          Status: "Exited (137) 20 seconds ago",
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
      ],
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      restartHostMachine: restartHostMock,
    });

    const agent = request.agent(app);
    const dashboardRes = await loginAndGetDashboard(agent, "admin1", "AdminPassword#2026");

    expect(dashboardRes.text).toContain("stopped-by-test");
    expect(dashboardRes.text).toContain("status-pill status-pill-stopped\" title=\"Stopped reason: Completed\">Stopped<");
    expect(dashboardRes.text).not.toContain("status-pill status-pill-stopped\">0<");
    expect(dashboardRes.text).toContain("stopped-oom");
    expect(dashboardRes.text).toContain("status-pill status-pill-stopped\" title=\"Stopped reason: Killed / Possible OOM\">Stopped<");
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

  it("groups containers by compose project rather than compose filename", async () => {
    const app = createApp({
      listContainers: async () => [
        {
          ID: "aaa111",
          Names: "service-a",
          Image: "repo/service-a:latest",
          Status: "Up 5 minutes",
          Command: "",
          CreatedAt: "",
          Labels:
            "com.docker.compose.project=stack-a,com.docker.compose.project.config_files=/srv/a/docker-compose.yml",
          LocalVolumes: "",
          Mounts: "",
          Networks: "",
          Ports: "",
          RunningFor: "",
          Size: "",
          State: "running",
        },
        {
          ID: "bbb222",
          Names: "service-b",
          Image: "repo/service-b:latest",
          Status: "Up 8 minutes",
          Command: "",
          CreatedAt: "",
          Labels:
            "com.docker.compose.project=stack-b,com.docker.compose.project.config_files=/srv/b/docker-compose.yml",
          LocalVolumes: "",
          Mounts: "",
          Networks: "",
          Ports: "",
          RunningFor: "",
          Size: "",
          State: "running",
        },
        {
          ID: "ccc333",
          Names: "service-c",
          Image: "repo/service-c:latest",
          Status: "Up 10 minutes",
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
    const dashboardRes = await loginAndGetDashboard(agent, "admin1", "AdminPassword#2026");

    expect(dashboardRes.text).toContain("stack-a");
    expect(dashboardRes.text).toContain("stack-b");
    expect(dashboardRes.text).toContain("Ungrouped");

    const stackAIndex = dashboardRes.text.indexOf("stack-a");
    const stackBIndex = dashboardRes.text.indexOf("stack-b");
    const ungroupedIndex = dashboardRes.text.indexOf("Ungrouped");

    expect(stackAIndex).toBeGreaterThan(-1);
    expect(stackBIndex).toBeGreaterThan(-1);
    expect(ungroupedIndex).toBeGreaterThan(-1);
    expect(ungroupedIndex).toBeGreaterThan(stackAIndex);
    expect(ungroupedIndex).toBeGreaterThan(stackBIndex);
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
        showContainerResources: "on",
        showServerResources: "on",
        showImageName: "on",
        showContainerHash: "on",
      });

    expect(saveRes.status).toBe(302);
    expect(saveRes.headers.location).toBe("/settings");

    const savedSettings = JSON.parse(await fs.readFile(dashboardSettingsFilePath, "utf-8")) as {
      appTitle: string;
      appSlogan: string;
      theme: string;
      backgroundImagePath: string;
      showContainerResources: boolean;
      showServerResources: boolean;
      showImageName: boolean;
      showContainerHash: boolean;
    };

    expect(savedSettings.appTitle).toBe("Custom Title");
    expect(savedSettings.appSlogan).toBe("Custom slogan");
    expect(savedSettings.theme).toBe("light");
    expect(savedSettings.showContainerResources).toBe(true);
    expect(savedSettings.showServerResources).toBe(true);
    expect(savedSettings.showImageName).toBe(true);
    expect(savedSettings.showContainerHash).toBe(true);

    const dashboardRes = await agent.get("/");
    expect(dashboardRes.status).toBe(200);
    expect(dashboardRes.text).toContain("Custom Title");
    expect(dashboardRes.text).toContain("Custom slogan");
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
        showContainerResources: "0",
        showServerResources: "0",
        showImageName: "on",
        showContainerHash: "on",
      });

    expect(saveRes.status).toBe(302);

    const dashboardRes = await agent.get("/");
    expect(dashboardRes.status).toBe(200);
    expect(dashboardRes.text).toContain("hidden-metrics-api");
    expect(dashboardRes.text).not.toContain("Resource Consumption");
    expect(dashboardRes.text).not.toContain("<th class=\"resource-desktop-col\">Resources</th>");
    expect(dashboardRes.text).not.toContain("<strong>CPU</strong>");
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
        showContainerResources: "on",
        showServerResources: "on",
        showImageName: "0",
        showContainerHash: "0",
      });

    expect(saveRes.status).toBe(302);

    const dashboardRes = await agent.get("/");
    expect(dashboardRes.status).toBe(200);
    expect(dashboardRes.text).toContain("hidden-image-and-hash");
    expect(dashboardRes.text).not.toContain("<th class=\"image-col\">Image</th>");
    expect(dashboardRes.text).not.toContain("repo/hidden-image-and-hash:latest");
    expect(dashboardRes.text).not.toContain("imgname111222");
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
    expect(dashboardRes.text).toContain("<th class=\"resource-desktop-col\">Resources</th>");

    const settingsRes = await agent.get("/settings");
    expect(settingsRes.status).toBe(200);
    expect(settingsRes.text).toContain('id="showContainerResources"');
    expect(settingsRes.text).toContain('name="showContainerResources"');
    expect(settingsRes.text).toContain('name="showServerResources"');
    expect(settingsRes.text).toContain('name="showImageName"');
    expect(settingsRes.text).toContain('name="showContainerHash"');

    const savedSettings = JSON.parse(await fs.readFile(dashboardSettingsFilePath, "utf-8")) as {
      showContainerResources: boolean;
      showServerResources: boolean;
      showImageName: boolean;
      showContainerHash: boolean;
    };
    expect(savedSettings.showContainerResources).toBe(true);
    expect(savedSettings.showServerResources).toBe(true);
    expect(savedSettings.showImageName).toBe(true);
    expect(savedSettings.showContainerHash).toBe(true);
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
      0x89, 0x50, 0x4e, 0x47,
      0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01,
      0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00,
      0x00, 0x1f, 0x15, 0xc4,
      0x89, 0x00, 0x00, 0x00,
      0x0a, 0x49, 0x44, 0x41,
      0x54, 0x78, 0x9c, 0x63,
      0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d,
      0x0a, 0x2d, 0xb4, 0x00,
      0x00, 0x00, 0x00, 0x49,
      0x45, 0x4e, 0x44, 0xae,
      0x42, 0x60, 0x82,
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

    const savedSettings = JSON.parse(await fs.readFile(dashboardSettingsFilePath, "utf-8")) as {
      backgroundImagePath: string;
    };

    expect(savedSettings.backgroundImagePath).toMatch(/^\/uploads\/backgrounds\/bg-/);

    const uploadedFile = path.join(
      dashboardUploadsDir,
      path.basename(savedSettings.backgroundImagePath)
    );
    const fileStat = await fs.stat(uploadedFile);
    expect(fileStat.isFile()).toBe(true);
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
});
