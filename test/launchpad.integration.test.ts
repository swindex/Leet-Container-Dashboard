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
import { resolveDataPath } from "../src/lib/dataPaths.js";

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

async function loginAndGetDashboard(agent: any, username: string, password: string) {
  const loginRes = await agent.post("/login").type("form").send({ username, password });
  expect(loginRes.status).toBe(302);
  expect(loginRes.headers.location).toBe("/");

  const dashboardRes = await agent.get("/");
  expect(dashboardRes.status).toBe(200);
  return dashboardRes;
}

describe("launchpad page integration", () => {
  let usersFilePath = "";
  let remoteServersFilePath = "";
  let restoreUsersFileContent: string | null = null;
  let usersFileExisted = false;
  let restoreCookieSecret: string | undefined;
  let restoreNodeEnv: string | undefined;

  const restartContainerMock = vi.fn(async (_containerId: string) => undefined);
  const startContainerMock = vi.fn(async (_containerId: string) => undefined);
  const stopContainerMock = vi.fn(async (_containerId: string) => undefined);
  const listContainerStatsMock = vi.fn(async () => []);
  const getHostInfoMock = vi.fn(async () => ({ NCPU: 8, MemTotal: 16 * 1024 * 1024 * 1024 }));
  const restartHostMock = vi.fn(async () => undefined);

  beforeAll(async () => {
    restoreCookieSecret = process.env.COOKIE_SECRET;
    restoreNodeEnv = process.env.NODE_ENV;

    // Explicitly set NODE_ENV to test to ensure data isolation
    process.env.NODE_ENV = "test";

    usersFilePath = resolveDataPath("users.json");
    remoteServersFilePath = resolveDataPath("remoteServers.json");

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
        username: "admin1",
        role: ROLES.ADMIN,
        password: "AdminPassword#2026",
        passwordHash: await bcrypt.hash("AdminPassword#2026", 10),
        active: true,
        createdAt: now,
        updatedAt: now,
      },
    ];

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

    process.env.COOKIE_SECRET = "integration-test-secret";
  });

  beforeEach(async () => {
    restartContainerMock.mockClear();
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

  it("renders launchpad page successfully", async () => {
    const app = createApp({
      listContainers: async () => [],
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      listContainerStats: listContainerStatsMock,
      getHostInfo: getHostInfoMock,
      restartHostMachine: restartHostMock,
    });

    const agent = request.agent(app);
    await loginAndGetDashboard(agent, "admin1", "AdminPassword#2026");

    const launchpadPage = await agent.get("/launchpad");
    expect(launchpadPage.status).toBe(200);
    expect(launchpadPage.text).toContain("Launchpad");

    const launchpadApi = await agent.get("/api/launchpad");
    expect(launchpadApi.status).toBe(200);
    expect(launchpadApi.body.success).toBe(true);
    expect(Array.isArray(launchpadApi.body.data.launchpadTiles)).toBe(true);
  });
});
