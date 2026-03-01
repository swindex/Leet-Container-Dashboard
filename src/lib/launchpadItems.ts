import fs from "fs/promises";
import crypto from "crypto";
import path from "path";
import { resolveDataPath } from "./dataPaths.js";
import { isDemoMode, logDemoAction } from "./demoMode.js";
import type { DockerContainer } from "./dockerCli.js";

const DEFAULT_LAUNCHPAD_PATH = resolveDataPath("launchpad.json");

export type LaunchpadItem = {
  id: string;
  serverId: string;
  containerId: string;
  containerName: string;
  name: string;
  description?: string;
  publicUrl: string;
  localUrl: string;
  icon: string;
  iconColor: string;
  hidden: boolean;
  status: "running" | "stopped" | "removed";
  lastSeen: string;
  autoDiscovered: boolean;
};

type LaunchpadFile = {
  lastSyncTime?: string;
  items: LaunchpadItem[];
};

function getLaunchpadFilePath(): string {
  return process.env.LAUNCHPAD_FILE || DEFAULT_LAUNCHPAD_PATH;
}

function validateLaunchpadFile(input: unknown): LaunchpadFile {
  const parsed = input as Partial<LaunchpadFile>;
  const inputItems = Array.isArray(parsed?.items) ? parsed.items : [];

  const items = inputItems.map((item) => {
    const partial = item as Partial<LaunchpadItem>;
    return {
      id: typeof partial.id === "string" ? partial.id : crypto.randomUUID(),
      serverId: typeof partial.serverId === "string" ? partial.serverId : "local",
      containerId: typeof partial.containerId === "string" ? partial.containerId : "",
      containerName: typeof partial.containerName === "string" ? partial.containerName : "",
      name: typeof partial.name === "string" ? partial.name : "",
      description: typeof partial.description === "string" ? partial.description : undefined,
      publicUrl: typeof partial.publicUrl === "string" ? partial.publicUrl : "",
      localUrl: typeof partial.localUrl === "string" ? partial.localUrl : "",
      icon: typeof partial.icon === "string" ? partial.icon : "fa-solid fa-rocket",
      iconColor: typeof partial.iconColor === "string" ? partial.iconColor : "launchpad-icon-default",
      hidden: typeof partial.hidden === "boolean" ? partial.hidden : false,
      status: (["running", "stopped", "removed"].includes(partial.status as string)
        ? partial.status
        : "stopped") as LaunchpadItem["status"],
      lastSeen: typeof partial.lastSeen === "string" ? partial.lastSeen : new Date().toISOString(),
      autoDiscovered: typeof partial.autoDiscovered === "boolean" ? partial.autoDiscovered : true,
    };
  });

  return {
    lastSyncTime: typeof parsed?.lastSyncTime === "string" ? parsed.lastSyncTime : undefined,
    items,
  };
}

async function ensureLaunchpadFileExists(filePath = getLaunchpadFilePath()): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    const defaultFile: LaunchpadFile = {
      items: [],
    };
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(defaultFile, null, 2), "utf-8");
  }
}

async function readLaunchpadFile(filePath = getLaunchpadFilePath()): Promise<LaunchpadFile> {
  await ensureLaunchpadFileExists(filePath);
  const text = await fs.readFile(filePath, "utf-8");
  const parsed = JSON.parse(text) as unknown;
  return validateLaunchpadFile(parsed);
}

async function writeLaunchpadFile(data: LaunchpadFile, filePath = getLaunchpadFilePath()): Promise<void> {
  const validated = validateLaunchpadFile(data);

  if (isDemoMode()) {
    logDemoAction("writeLaunchpadFile", {
      itemCount: validated.items.length,
      lastSyncTime: validated.lastSyncTime,
    });
    return;
  }

  await fs.writeFile(filePath, JSON.stringify(validated, null, 2), "utf-8");
}

export async function listLaunchpadItems(): Promise<LaunchpadItem[]> {
  const file = await readLaunchpadFile();
  return file.items;
}

export async function getLaunchpadItemById(id: string): Promise<LaunchpadItem | null> {
  const file = await readLaunchpadFile();
  return file.items.find((item) => item.id === id) ?? null;
}

export async function createLaunchpadItem(input: {
  serverId: string;
  containerId: string;
  containerName: string;
  name: string;
  description?: string;
  publicUrl?: string;
  localUrl?: string;
  icon?: string;
  iconColor?: string;
  hidden?: boolean;
}): Promise<void> {
  const file = await readLaunchpadFile();

  file.items.push({
    id: crypto.randomUUID(),
    serverId: input.serverId,
    containerId: input.containerId,
    containerName: input.containerName,
    name: input.name,
    description: input.description,
    publicUrl: input.publicUrl || "",
    localUrl: input.localUrl || "",
    icon: input.icon || "fa-solid fa-rocket",
    iconColor: input.iconColor || "launchpad-icon-default",
    hidden: input.hidden ?? false,
    status: "stopped",
    lastSeen: new Date().toISOString(),
    autoDiscovered: false,
  });

  await writeLaunchpadFile(file);
}

export async function updateLaunchpadItem(
  id: string,
  input: {
    name?: string;
    description?: string;
    publicUrl?: string;
    icon?: string;
    iconColor?: string;
    hidden?: boolean;
  }
): Promise<void> {
  const file = await readLaunchpadFile();
  const target = file.items.find((item) => item.id === id);

  if (!target) {
    throw new Error("Launchpad item not found");
  }

  if (typeof input.name === "string") {
    target.name = input.name;
  }
  if (typeof input.description === "string") {
    target.description = input.description || undefined;
  }
  if (typeof input.publicUrl === "string") {
    target.publicUrl = input.publicUrl;
  }
  if (typeof input.icon === "string") {
    target.icon = input.icon;
  }
  if (typeof input.iconColor === "string") {
    target.iconColor = input.iconColor;
  }
  if (typeof input.hidden === "boolean") {
    target.hidden = input.hidden;
  }

  await writeLaunchpadFile(file);
}

export async function toggleLaunchpadItemVisibility(id: string): Promise<boolean> {
  const file = await readLaunchpadFile();
  const target = file.items.find((item) => item.id === id);

  if (!target) {
    throw new Error("Launchpad item not found");
  }

  target.hidden = !target.hidden;
  await writeLaunchpadFile(file);
  
  return target.hidden;
}

export async function deleteLaunchpadItem(id: string): Promise<void> {
  const file = await readLaunchpadFile();
  const target = file.items.find((item) => item.id === id);

  if (!target) {
    throw new Error("Launchpad item not found");
  }

  file.items = file.items.filter((item) => item.id !== id);
  await writeLaunchpadFile(file);
}

export async function getLastSyncTime(): Promise<string | null> {
  const file = await readLaunchpadFile();
  return file.lastSyncTime ?? null;
}

export async function shouldSyncImmediately(): Promise<boolean> {
  try {
    const file = await readLaunchpadFile();
    
    // No items at all - sync immediately
    if (file.items.length === 0) {
      return true;
    }
    
    // No last sync time recorded - sync immediately
    if (!file.lastSyncTime) {
      return true;
    }
    
    // Last sync was more than 5 minutes ago - sync immediately
    const lastSync = new Date(file.lastSyncTime).getTime();
    const now = Date.now();
    const fiveMinutesMs = 5 * 60 * 1000;
    
    if (now - lastSync > fiveMinutesMs) {
      return true;
    }
    
    return false;
  } catch {
    // File doesn't exist or error reading - sync immediately
    return true;
  }
}

export { readLaunchpadFile, writeLaunchpadFile };
