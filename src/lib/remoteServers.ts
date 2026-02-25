import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

const DEFAULT_REMOTE_SERVERS_PATH = path.resolve(process.cwd(), "data", "remoteServers.json");

export type RemoteServer = {
  id: string;
  name: string;
  host: string;
  username: string;
  password: string;
  enabled: boolean;
  isLocal: boolean;
};

type RemoteServersFile = {
  defaultServerId: string;
  servers: RemoteServer[];
};

const LOCAL_SERVER_ID = "local";

function getRemoteServersFilePath(): string {
  return process.env.REMOTE_SERVERS_FILE || DEFAULT_REMOTE_SERVERS_PATH;
}

function createDefaultLocalServer(): RemoteServer {
  return {
    id: LOCAL_SERVER_ID,
    name: "Local Server",
    host: "localhost",
    username: "",
    password: "",
    enabled: true,
    isLocal: true,
  };
}

function normalizeServer(input: Partial<RemoteServer>, fallback?: RemoteServer): RemoteServer {
  const base = fallback ?? createDefaultLocalServer();
  return {
    id: typeof input.id === "string" && input.id.trim() ? input.id.trim() : base.id,
    name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : base.name,
    host: typeof input.host === "string" ? input.host.trim() : base.host,
    username: typeof input.username === "string" ? input.username.trim() : base.username,
    password: typeof input.password === "string" ? input.password : base.password,
    enabled: typeof input.enabled === "boolean" ? input.enabled : base.enabled,
    isLocal: typeof input.isLocal === "boolean" ? input.isLocal : base.isLocal,
  };
}

function validateRemoteServersFile(input: unknown): RemoteServersFile {
  const parsed = input as Partial<RemoteServersFile>;
  const inputServers = Array.isArray(parsed?.servers) ? parsed.servers : [];

  const normalized = inputServers.map((server, idx) => {
    const fallback = idx === 0 ? createDefaultLocalServer() : undefined;
    return normalizeServer(server as Partial<RemoteServer>, fallback);
  });

  const localCandidate = normalized.find((server) => server.id === LOCAL_SERVER_ID || server.isLocal) ?? {};
  const localServer = normalizeServer(localCandidate, createDefaultLocalServer());
  localServer.id = LOCAL_SERVER_ID;
  localServer.isLocal = true;
  localServer.enabled = true;

  const remoteServers = normalized
    .filter((server) => server.id !== LOCAL_SERVER_ID && !server.isLocal)
    .map((server) => ({ ...server, isLocal: false }));

  const servers = [localServer, ...remoteServers];

  const ids = new Set<string>();
  for (const server of servers) {
    if (ids.has(server.id)) {
      throw new Error(`Duplicate server id '${server.id}' in remote server config.`);
    }
    ids.add(server.id);
  }

  const defaultServerId =
    typeof parsed?.defaultServerId === "string" && ids.has(parsed.defaultServerId)
      ? parsed.defaultServerId
      : LOCAL_SERVER_ID;

  return {
    defaultServerId,
    servers,
  };
}

async function ensureRemoteServersFileExists(filePath = getRemoteServersFilePath()): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    const defaultFile: RemoteServersFile = {
      defaultServerId: LOCAL_SERVER_ID,
      servers: [createDefaultLocalServer()],
    };
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(defaultFile, null, 2), "utf-8");
  }
}

async function readRemoteServersFile(filePath = getRemoteServersFilePath()): Promise<RemoteServersFile> {
  await ensureRemoteServersFileExists(filePath);
  const text = await fs.readFile(filePath, "utf-8");
  const parsed = JSON.parse(text) as unknown;
  return validateRemoteServersFile(parsed);
}

async function writeRemoteServersFile(data: RemoteServersFile, filePath = getRemoteServersFilePath()): Promise<void> {
  const validated = validateRemoteServersFile(data);
  await fs.writeFile(filePath, JSON.stringify(validated, null, 2), "utf-8");
}

export async function listRemoteServers(): Promise<{ defaultServerId: string; servers: RemoteServer[] }> {
  const file = await readRemoteServersFile();
  return {
    defaultServerId: file.defaultServerId,
    servers: file.servers,
  };
}

export async function getRemoteServerById(serverId: string): Promise<RemoteServer | null> {
  const file = await readRemoteServersFile();
  return file.servers.find((server) => server.id === serverId) ?? null;
}

export async function resolveServerByIdOrDefault(serverId?: string): Promise<{ server: RemoteServer; defaultServerId: string }> {
  const { defaultServerId, servers } = await listRemoteServers();
  const enabledServers = servers.filter((server) => server.enabled);
  const fallbackServer = enabledServers.find((server) => server.id === defaultServerId) ?? servers[0];

  const requested =
    serverId && serverId.trim()
      ? enabledServers.find((server) => server.id === serverId) ?? fallbackServer
      : fallbackServer;

  return {
    server: requested,
    defaultServerId,
  };
}

export async function setDefaultServer(serverId: string): Promise<void> {
  const file = await readRemoteServersFile();
  const target = file.servers.find((server) => server.id === serverId);
  if (!target) {
    throw new Error("Server not found");
  }
  if (!target.enabled) {
    throw new Error("Cannot set a disabled server as default");
  }

  file.defaultServerId = target.id;
  await writeRemoteServersFile(file);
}

export async function createRemoteServer(input: {
  name: string;
  host: string;
  username: string;
  password: string;
  enabled: boolean;
}): Promise<void> {
  const name = input.name.trim();
  const host = input.host.trim();
  const username = input.username.trim();

  if (!name) {
    throw new Error("Server name is required");
  }
  if (!host) {
    throw new Error("Server host is required");
  }
  if (!username) {
    throw new Error("Server username is required");
  }

  const file = await readRemoteServersFile();
  file.servers.push({
    id: crypto.randomUUID(),
    name,
    host,
    username,
    password: input.password,
    enabled: input.enabled,
    isLocal: false,
  });

  await writeRemoteServersFile(file);
}

export async function updateRemoteServer(
  serverId: string,
  input: {
    name: string;
    host: string;
    username: string;
    password?: string;
    enabled: boolean;
  }
): Promise<void> {
  const file = await readRemoteServersFile();
  const target = file.servers.find((server) => server.id === serverId);
  if (!target) {
    throw new Error("Server not found");
  }
  if (target.isLocal) {
    throw new Error("Local server cannot be edited");
  }

  const name = input.name.trim();
  const host = input.host.trim();
  const username = input.username.trim();

  if (!name || !host || !username) {
    throw new Error("Name, host, and username are required");
  }

  target.name = name;
  target.host = host;
  target.username = username;
  if (typeof input.password === "string" && input.password.length > 0) {
    target.password = input.password;
  }
  target.enabled = input.enabled;

  if (!target.enabled && file.defaultServerId === target.id) {
    file.defaultServerId = LOCAL_SERVER_ID;
  }

  await writeRemoteServersFile(file);
}

export async function deleteRemoteServer(serverId: string): Promise<void> {
  const file = await readRemoteServersFile();
  const target = file.servers.find((server) => server.id === serverId);
  if (!target) {
    throw new Error("Server not found");
  }
  if (target.isLocal) {
    throw new Error("Local server cannot be deleted");
  }

  file.servers = file.servers.filter((server) => server.id !== serverId);
  if (file.defaultServerId === serverId) {
    file.defaultServerId = LOCAL_SERVER_ID;
  }

  await writeRemoteServersFile(file);
}
