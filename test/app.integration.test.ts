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
  let restoreUsersFile: string | undefined;
  let restoreCookieSecret: string | undefined;

  const restartContainerMock = vi.fn(async (_containerId: string) => undefined);
  const removeContainerMock = vi.fn(async (_containerId: string) => undefined);
  const startContainerMock = vi.fn(async (_containerId: string) => undefined);
  const stopContainerMock = vi.fn(async (_containerId: string) => undefined);
  const restartHostMock = vi.fn(async () => undefined);

  beforeAll(async () => {
    restoreUsersFile = process.env.USERS_FILE;
    restoreCookieSecret = process.env.COOKIE_SECRET;

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
    usersFilePath = path.join(tempDir, "users.json");

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

    process.env.USERS_FILE = usersFilePath;
    process.env.COOKIE_SECRET = "integration-test-secret";
  });

  beforeEach(() => {
    restartContainerMock.mockClear();
    removeContainerMock.mockClear();
    startContainerMock.mockClear();
    stopContainerMock.mockClear();
    restartHostMock.mockClear();
  });

  afterAll(async () => {
    if (restoreUsersFile === undefined) {
      delete process.env.USERS_FILE;
    } else {
      process.env.USERS_FILE = restoreUsersFile;
    }

    if (restoreCookieSecret === undefined) {
      delete process.env.COOKIE_SECRET;
    } else {
      process.env.COOKIE_SECRET = restoreCookieSecret;
    }

    if (usersFilePath) {
      await fs.rm(path.dirname(usersFilePath), { recursive: true, force: true });
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

    expect(dashboardRes.text).toContain("Home Server Dashboard");
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
      restartHostMachine: restartHostMock,
    });

    const agent = request.agent(app);
    const dashboardRes = await loginAndGetDashboard(agent, "admin1", "AdminPassword#2026");

    expect(dashboardRes.text).toContain("uptime-check");
    expect(dashboardRes.text).toContain("8 seconds");
    expect(dashboardRes.text).not.toContain(">2 hours<");
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
