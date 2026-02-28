import fs from "fs/promises";
import crypto from "crypto";
import path from "path";
import { resolveDataPath } from "./dataPaths.js";
import { isDemoMode, logDemoAction } from "./demoMode.js";
import { validateOrThrow, createServerSchema, updateServerSchema, updateLocalServerSchema } from "./validation.js";

const DEFAULT_REMOTE_SERVERS_PATH = resolveDataPath("remoteServers.json");
const ENCRYPTED_PASSWORD_PREFIX = "enc:v1";

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
let runtimeRemoteServersKey: Buffer | null = null;

function getRemoteServersEncryptionKey(): Buffer {
  const configured = process.env.REMOTE_SERVERS_KEY?.trim();
  if (configured) {
    return crypto.createHash("sha256").update(configured).digest();
  }

  if (!runtimeRemoteServersKey) {
    runtimeRemoteServersKey = crypto.randomBytes(32);
    console.warn("REMOTE_SERVERS_KEY is not set. Using an ephemeral key for remote server password encryption.");
  }

  return runtimeRemoteServersKey;
}

function encryptRemoteServerPassword(plainText: string): string {
  if (!plainText) {
    return "";
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getRemoteServersEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${ENCRYPTED_PASSWORD_PREFIX}:${iv.toString("base64url")}:${authTag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

function decryptRemoteServerPassword(storedValue: string): string {
  if (!storedValue || !storedValue.startsWith(`${ENCRYPTED_PASSWORD_PREFIX}:`)) {
    return storedValue;
  }

  const parts = storedValue.split(":");
  if (parts.length !== 5) {
    throw new Error("Invalid encrypted password format in remote server config.");
  }

  const iv = Buffer.from(parts[2], "base64url");
  const authTag = Buffer.from(parts[3], "base64url");
  const encrypted = Buffer.from(parts[4], "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getRemoteServersEncryptionKey(), iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf-8");
}

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

function resolveDefaultServerId(servers: RemoteServer[], requestedDefaultServerId?: string): string {
  if (!servers.length) {
    return LOCAL_SERVER_ID;
  }

  if (requestedDefaultServerId && servers.some((server) => server.id === requestedDefaultServerId)) {
    return requestedDefaultServerId;
  }

  const firstEnabled = servers.find((server) => server.enabled);
  return firstEnabled?.id ?? servers[0].id;
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

  const servers = inputServers.map((server) => {
    const normalized = normalizeServer(server as Partial<RemoteServer>);
    if (normalized.id === LOCAL_SERVER_ID || normalized.isLocal) {
      return {
        ...normalized,
        id: LOCAL_SERVER_ID,
        isLocal: true,
      };
    }

    return {
      ...normalized,
      isLocal: false,
    };
  });

  const ids = new Set<string>();
  for (const server of servers) {
    if (ids.has(server.id)) {
      throw new Error(`Duplicate server id '${server.id}' in remote server config.`);
    }
    ids.add(server.id);
  }

  const requestedDefaultServerId = typeof parsed?.defaultServerId === "string"
    ? parsed.defaultServerId
    : undefined;
  const defaultServerId = resolveDefaultServerId(servers, requestedDefaultServerId);

  return {
    defaultServerId,
    servers,
  };
}

function decryptRemoteServerPasswords(file: RemoteServersFile): RemoteServersFile {
  return {
    ...file,
    servers: file.servers.map((server) => ({
      ...server,
      password: decryptRemoteServerPassword(server.password || ""),
    })),
  };
}

function encryptRemoteServerPasswords(file: RemoteServersFile): RemoteServersFile {
  return {
    ...file,
    servers: file.servers.map((server) => {
      if (server.isLocal) {
        return {
          ...server,
          password: "",
        };
      }

      return {
        ...server,
        password: encryptRemoteServerPassword(server.password || ""),
      };
    }),
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
  const validated = validateRemoteServersFile(parsed);
  return decryptRemoteServerPasswords(validated);
}

async function writeRemoteServersFile(data: RemoteServersFile, filePath = getRemoteServersFilePath()): Promise<void> {
  const validated = validateRemoteServersFile(data);
  
  if (isDemoMode()) {
    logDemoAction("writeRemoteServersFile", { 
      serverCount: validated.servers.length,
      defaultServerId: validated.defaultServerId 
    });
    return;
  }
  
  const encrypted = encryptRemoteServerPasswords(validated);
  await fs.writeFile(filePath, JSON.stringify(encrypted, null, 2), "utf-8");
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
  if (!servers.length) {
    throw new Error("No servers configured");
  }

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
  // Validate using Joi schema
  const validated = validateOrThrow<{
    name: string;
    host: string;
    username: string;
    password: string;
    enabled: boolean;
  }>(createServerSchema, input);

  const file = await readRemoteServersFile();
  file.servers.push({
    id: crypto.randomUUID(),
    name: validated.name,
    host: validated.host,
    username: validated.username,
    password: validated.password,
    enabled: validated.enabled,
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

  // Use different schema for local vs remote servers
  const schema = target.isLocal ? updateLocalServerSchema : updateServerSchema;
  const validated = validateOrThrow<{
    name: string;
    host: string;
    username: string;
    password?: string;
    enabled: boolean;
  }>(schema, input);

  target.name = validated.name;
  target.host = validated.host;
  target.username = validated.username;
  if (typeof validated.password === "string" && validated.password.length > 0) {
    target.password = validated.password;
  }
  target.enabled = validated.enabled;

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

  file.servers = file.servers.filter((server) => server.id !== serverId);
  file.defaultServerId = resolveDefaultServerId(file.servers, file.defaultServerId === serverId ? undefined : file.defaultServerId);

  await writeRemoteServersFile(file);
}

export async function addDefaultLocalServer(): Promise<void> {
  const file = await readRemoteServersFile();
  if (file.servers.some((server) => server.id === LOCAL_SERVER_ID || server.isLocal)) {
    throw new Error("Local server already exists");
  }

  file.servers.unshift(createDefaultLocalServer());
  file.defaultServerId = resolveDefaultServerId(file.servers, file.defaultServerId);

  await writeRemoteServersFile(file);
}
