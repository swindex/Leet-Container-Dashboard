import fs from "fs/promises";
import path from "path";
import { resolveDataPath } from "./dataPaths.js";
import { isDemoMode, logDemoAction } from "./demoMode.js";

const DEFAULT_DASHBOARD_SETTINGS_PATH = resolveDataPath("dashboardSettings.json");

export type DashboardTheme = "dark" | "light";

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

export const DEFAULT_DASHBOARD_SETTINGS: DashboardSettings = {
  appTitle: "Leet Container Dashboard",
  appSlogan: "Manage your containers with style",
  theme: "dark",
  backgroundImagePath: "",
  hideAttributionFooter: false,
  showContainerResources: true,
  showServerResources: true,
  showImageName: true,
  showContainerHash: true,
};

function getDashboardSettingsFilePath(): string {
  return process.env.DASHBOARD_SETTINGS_FILE || DEFAULT_DASHBOARD_SETTINGS_PATH;
}

function validateDashboardSettings(input: unknown): DashboardSettings {
  const parsed = input as Partial<DashboardSettings>;
  return {
    appTitle: typeof parsed?.appTitle === "string" ? parsed.appTitle : DEFAULT_DASHBOARD_SETTINGS.appTitle,
    appSlogan: typeof parsed?.appSlogan === "string" ? parsed.appSlogan : DEFAULT_DASHBOARD_SETTINGS.appSlogan,
    theme: parsed?.theme === "light" ? "light" : "dark",
    backgroundImagePath: typeof parsed?.backgroundImagePath === "string" ? parsed.backgroundImagePath : "",
    hideAttributionFooter: typeof parsed?.hideAttributionFooter === "boolean" ? parsed.hideAttributionFooter : DEFAULT_DASHBOARD_SETTINGS.hideAttributionFooter,
    showContainerResources: typeof parsed?.showContainerResources === "boolean" ? parsed.showContainerResources : DEFAULT_DASHBOARD_SETTINGS.showContainerResources,
    showServerResources: typeof parsed?.showServerResources === "boolean" ? parsed.showServerResources : DEFAULT_DASHBOARD_SETTINGS.showServerResources,
    showImageName: typeof parsed?.showImageName === "boolean" ? parsed.showImageName : DEFAULT_DASHBOARD_SETTINGS.showImageName,
    showContainerHash: typeof parsed?.showContainerHash === "boolean" ? parsed.showContainerHash : DEFAULT_DASHBOARD_SETTINGS.showContainerHash,
  };
}

async function ensureDashboardSettingsFileExists(filePath = getDashboardSettingsFilePath()): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    const defaultSettings = { ...DEFAULT_DASHBOARD_SETTINGS };
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(defaultSettings, null, 2), "utf-8");
  }
}

async function readDashboardSettings(filePath = getDashboardSettingsFilePath()): Promise<DashboardSettings> {
  await ensureDashboardSettingsFileExists(filePath);
  const text = await fs.readFile(filePath, "utf-8");
  const parsed = JSON.parse(text) as unknown;
  return validateDashboardSettings(parsed);
}

async function writeDashboardSettings(settings: DashboardSettings, filePath = getDashboardSettingsFilePath()): Promise<void> {
  const validated = validateDashboardSettings(settings);

  if (isDemoMode()) {
    logDemoAction("writeDashboardSettings", validated);
    return;
  }

  await fs.writeFile(filePath, JSON.stringify(validated, null, 2), "utf-8");
}

export async function getDashboardSettings(): Promise<DashboardSettings> {
  return readDashboardSettings();
}

export async function updateDashboardSettings(patch: Partial<DashboardSettings>): Promise<void> {
  const current = await readDashboardSettings();
  const updated: DashboardSettings = { ...current, ...patch };
  await writeDashboardSettings(updated);
}

export function getDashboardBackgroundUploadsPath(): string {
  return resolveDataPath("uploads", "backgrounds");
}

export function getLaunchpadIconsUploadsPath(): string {
  return resolveDataPath("uploads", "launchpad-icons");
}
