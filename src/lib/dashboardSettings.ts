import fs from "fs/promises";
import path from "path";
import { resolveDataPath } from "./dataPaths.js";
import { isDemoMode, logDemoAction } from "./demoMode.js";
import { validateOrThrow, updateSettingsSchema } from "./validation.js";

export const DEFAULT_DASHBOARD_SETTINGS = {
  appTitle: "Leet Container Dashboard",
  appSlogan: "Monitor and control containers on your network.",
  theme: "dark",
  backgroundImagePath: "",
  hideAttributionFooter: false,
  showContainerResources: true,
  showServerResources: true,
  showImageName: true,
  showContainerHash: true,
} as const;

export type DashboardTheme = "light" | "dark";

export type DashboardSettings = {
  appTitle: string;
  appSlogan: string;
  theme: DashboardTheme;
  backgroundImagePath: string;
  hideAttributionFooter: boolean;
  showContainerResources: boolean;
  showServerResources: boolean;
  showImageName: boolean;
  showContainerHash: boolean;
};

const DEFAULT_DASHBOARD_SETTINGS_PATH = resolveDataPath("dashboardSettings.json");
const DEFAULT_DASHBOARD_UPLOADS_PATH = resolveDataPath("uploads", "backgrounds");

export function getDashboardSettingsFilePath(): string {
  return process.env.DASHBOARD_SETTINGS_FILE || DEFAULT_DASHBOARD_SETTINGS_PATH;
}

export function getDashboardBackgroundUploadsPath(): string {
  return process.env.DASHBOARD_UPLOADS_DIR || DEFAULT_DASHBOARD_UPLOADS_PATH;
}

function toBackgroundImagePath(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.trim();
  if (!normalized.startsWith("/uploads/backgrounds/")) {
    return "";
  }

  return normalized;
}

function normalizeSettings(input: Partial<DashboardSettings>): DashboardSettings {
  // Use Joi validation for the core settings
  const validated = validateOrThrow<{
    appTitle: string;
    appSlogan: string;
    theme: DashboardTheme;
    hideAttributionFooter: boolean;
    showContainerResources: boolean;
    showServerResources: boolean;
    showImageName: boolean;
    showContainerHash: boolean;
  }>(updateSettingsSchema, {
    appTitle: input.appTitle,
    appSlogan: input.appSlogan,
    theme: input.theme,
    hideAttributionFooter: input.hideAttributionFooter,
    showContainerResources: input.showContainerResources,
    showServerResources: input.showServerResources,
    showImageName: input.showImageName,
    showContainerHash: input.showContainerHash,
  });

  return {
    ...validated,
    backgroundImagePath: toBackgroundImagePath(input.backgroundImagePath),
  };
}

async function ensureDashboardSettingsFileExists(filePath = getDashboardSettingsFilePath()): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(DEFAULT_DASHBOARD_SETTINGS, null, 2), "utf-8");
  }
}

export async function getDashboardSettings(filePath = getDashboardSettingsFilePath()): Promise<DashboardSettings> {
  await ensureDashboardSettingsFileExists(filePath);

  try {
    const fileContent = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(fileContent) as Partial<DashboardSettings>;
    const normalized = normalizeSettings(parsed);

    if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
      await saveDashboardSettings(normalized, filePath);
    }

    return normalized;
  } catch {
    await saveDashboardSettings(DEFAULT_DASHBOARD_SETTINGS, filePath);
    return {
      ...DEFAULT_DASHBOARD_SETTINGS,
    };
  }
}

export async function saveDashboardSettings(settings: Partial<DashboardSettings>, filePath = getDashboardSettingsFilePath()): Promise<DashboardSettings> {
  const normalized = normalizeSettings(settings);
  
  if (isDemoMode()) {
    logDemoAction("saveDashboardSettings", { settings: normalized });
    return normalized;
  }
  
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(normalized, null, 2), "utf-8");
  return normalized;
}

export async function updateDashboardSettings(
  patch: Partial<DashboardSettings>,
  filePath = getDashboardSettingsFilePath()
): Promise<DashboardSettings> {
  const current = await getDashboardSettings(filePath);
  return saveDashboardSettings({ ...current, ...patch }, filePath);
}