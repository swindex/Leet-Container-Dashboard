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

async function readRemoteServersFromFile(remoteServersFilePath: string): Promise<{
  defaultServerId: string;
  servers: Array<{
    id: string;
    name: string;
    host: string;
    username: string;
    password: string;
    enabled: boolean;
    isLocal: boolean;
  }>;
}> {
  return JSON.parse(await fs.readFile(remoteServersFilePath, "utf-8")) as {
    defaultServerId: string;
    servers: Array<{
      id: string;
      name: string;
      host: string;
      username: string;
      password: string;
      enabled: boolean;
      isLocal: boolean;
    }>;
  };
}

describe("server management page integration", () => {
  let usersFilePath = "";
  let remoteServersFilePath = "";
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
        username: "admin1",
        role: ROLES.ADMIN,
        passwordHash: await bcrypt.hash("AdminPassword#2026", 10),
        active: true,
        createdAt: now,
        updatedAt: now,
      },
    ];

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

    process.env.COOKIE_SECRET = "integration-test-secret";
  });

  beforeEach(async () => {
    restartContainerMock.mockClear();
    startContainerMock.mockClear();
    stopContainerMock.mockClear();
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

  it("stores remote server passwords encrypted at rest", async () => {
    const app = createApp({
      listContainers: async () => [],
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      restartHostMachine: restartHostMock,
    });

    const agent = request.agent(app);
    await loginAndGetDashboard(agent, "admin1", "AdminPassword#2026");

    const serversPage = await agent.get("/servers");
    expect(serversPage.status).toBe(200);
    const csrf = extractCsrfToken(serversPage.text);

    const createServerRes = await agent
      .post("/servers")
      .type("form")
      .send({
        _csrf: csrf,
        name: "Encrypted Remote",
        host: "10.0.0.99",
        username: "root",
        password: "TopSecret#Pass123",
        enabled: "on",
      });

    expect(createServerRes.status).toBe(302);
    expect(createServerRes.headers.location).toBe("/servers");

    const fileText = await fs.readFile(remoteServersFilePath, "utf-8");
    expect(fileText).toContain("enc:v1:");
    expect(fileText).not.toContain("TopSecret#Pass123");

    const remoteServers = await readRemoteServersFromFile(remoteServersFilePath);
    expect(remoteServers.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Encrypted Remote",
          host: "10.0.0.99",
          username: "root",
          password: expect.stringMatching(/^enc:v1:/),
          isLocal: false,
        }),
      ])
    );
  });

  it("allows admin to edit/delete local server and add it back with defaults", async () => {
    const app = createApp({
      listContainers: async () => [],
      startContainerById: startContainerMock,
      stopContainerById: stopContainerMock,
      restartContainerById: restartContainerMock,
      restartHostMachine: restartHostMock,
    });

    const agent = request.agent(app);
    await loginAndGetDashboard(agent, "admin1", "AdminPassword#2026");

    const serversPage = await agent.get("/servers");
    expect(serversPage.status).toBe(200);
    expect(serversPage.text).toContain("Server Management");
    expect(serversPage.text).toContain("Add Remote Server");
    expect(serversPage.text).not.toContain("Add Local Server");

    const csrf = extractCsrfToken(serversPage.text);

    const updateLocalRes = await agent
      .post("/servers/local/update")
      .type("form")
      .send({
        _csrf: csrf,
        name: "Edited Local",
        host: "127.0.0.1",
        username: "",
        password: "",
        enabled: "on",
      });

    expect(updateLocalRes.status).toBe(302);
    expect(updateLocalRes.headers.location).toBe("/servers");

    let remoteServers = await readRemoteServersFromFile(remoteServersFilePath);
    expect(remoteServers.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "local",
          name: "Edited Local",
          host: "127.0.0.1",
          isLocal: true,
          enabled: true,
        }),
      ])
    );

    const deleteLocalRes = await agent
      .post("/servers/local/delete")
      .type("form")
      .send({ _csrf: csrf });

    expect(deleteLocalRes.status).toBe(302);
    expect(deleteLocalRes.headers.location).toBe("/servers");

    remoteServers = await readRemoteServersFromFile(remoteServersFilePath);
    expect(remoteServers.servers.find((server) => server.id === "local")).toBeUndefined();

    const noLocalServersPage = await agent.get("/servers");
    expect(noLocalServersPage.status).toBe(200);
    expect(noLocalServersPage.text).toContain("Add Local Server");

    const csrfWithoutLocal = extractCsrfToken(noLocalServersPage.text);
    const addLocalRes = await agent
      .post("/servers/local/add")
      .type("form")
      .send({ _csrf: csrfWithoutLocal });

    expect(addLocalRes.status).toBe(302);
    expect(addLocalRes.headers.location).toBe("/servers");

    remoteServers = await readRemoteServersFromFile(remoteServersFilePath);
    expect(remoteServers.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "local",
          name: "Local Server",
          host: "localhost",
          username: "",
          enabled: true,
          isLocal: true,
        }),
      ])
    );
  });
});
