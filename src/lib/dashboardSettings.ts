import path from "path";
import { resolveDataPath } from "./dataPaths.js";
import { isDemoMode } from "./demoMode.js";
import * as fs from "./fileSystem.js";

const DEFAULT_DASHBOARD_SETTINGS_PATH = resolveDataPath("dashboardSettings.json");

export type DashboardTheme = "dark" | "light";
export type DefaultViewPage = "dashboard" | "launchpad";

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
  dashboardRefreshInterval: number;
  defaultViewPage: DefaultViewPage;
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
  dashboardRefreshInterval: 5000,
  defaultViewPage: "dashboard",
};

function getDashboardSettingsFilePath(): string {
  return DEFAULT_DASHBOARD_SETTINGS_PATH;
}

function validateDashboardSettings(input: unknown): DashboardSettings {
  const parsed = input as Partial<DashboardSettings>;
  
  // Validate and clamp dashboard refresh interval (3-60 seconds)
  let refreshInterval = DEFAULT_DASHBOARD_SETTINGS.dashboardRefreshInterval;
  if (typeof parsed?.dashboardRefreshInterval === "number") {
    refreshInterval = Math.max(3000, Math.min(60000, parsed.dashboardRefreshInterval));
  }
  
  // Validate defaultViewPage
  let defaultViewPage: DefaultViewPage = DEFAULT_DASHBOARD_SETTINGS.defaultViewPage;
  if (parsed?.defaultViewPage === "launchpad" || parsed?.defaultViewPage === "dashboard") {
    defaultViewPage = parsed.defaultViewPage;
  }
  
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
    dashboardRefreshInterval: refreshInterval,
    defaultViewPage: defaultViewPage,
  };
}

async function ensureDashboardSettingsFileExists(filePath = getDashboardSettingsFilePath()): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    const defaultSettings = { ...DEFAULT_DASHBOARD_SETTINGS };
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(defaultSettings, null, 2));
  }
}

async function readDashboardSettings(filePath = getDashboardSettingsFilePath()): Promise<DashboardSettings> {
  await ensureDashboardSettingsFileExists(filePath);
  const text = await fs.readFile(filePath, "utf-8");
  const parsed = JSON.parse(text) as unknown;
  const validated = validateDashboardSettings(parsed);
  
  // Migrate legacy settings by writing defaults for missing properties
  const parsedObj = parsed as Partial<DashboardSettings>;
  const needsMigration = 
    typeof parsedObj?.hideAttributionFooter !== "boolean" ||
    typeof parsedObj?.showContainerResources !== "boolean" ||
    typeof parsedObj?.showServerResources !== "boolean" ||
    typeof parsedObj?.showImageName !== "boolean" ||
    typeof parsedObj?.showContainerHash !== "boolean" ||
    typeof parsedObj?.dashboardRefreshInterval !== "number" ||
    (parsedObj?.defaultViewPage !== "dashboard" && parsedObj?.defaultViewPage !== "launchpad");
  
  if (needsMigration && !isDemoMode()) {
    await fs.writeFile(filePath, JSON.stringify(validated, null, 2));
  }
  
  return validated;
}

async function writeDashboardSettings(settings: DashboardSettings, filePath = getDashboardSettingsFilePath()): Promise<void> {
  const validated = validateDashboardSettings(settings);
  await fs.writeFile(filePath, JSON.stringify(validated, null, 2));
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
