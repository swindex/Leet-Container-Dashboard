import fs from "fs/promises";
import path from "path";

export const DEFAULT_DASHBOARD_SETTINGS = {
  appTitle: "Leet Container Dashboard",
  appSlogan: "Monitor and control containers on your network.",
  theme: "dark",
  backgroundImagePath: "",
} as const;

export type DashboardTheme = "light" | "dark";

export type DashboardSettings = {
  appTitle: string;
  appSlogan: string;
  theme: DashboardTheme;
  backgroundImagePath: string;
};

const DEFAULT_DASHBOARD_SETTINGS_PATH = path.resolve(process.cwd(), "data", "dashboardSettings.json");
const DEFAULT_DASHBOARD_UPLOADS_PATH = path.resolve(process.cwd(), "data", "uploads", "backgrounds");

export function getDashboardSettingsFilePath(): string {
  return process.env.DASHBOARD_SETTINGS_FILE || DEFAULT_DASHBOARD_SETTINGS_PATH;
}

export function getDashboardBackgroundUploadsPath(): string {
  return process.env.DASHBOARD_UPLOADS_DIR || DEFAULT_DASHBOARD_UPLOADS_PATH;
}

function toTheme(value: unknown): DashboardTheme {
  return value === "light" ? "light" : "dark";
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
  const appTitle = typeof input.appTitle === "string" ? input.appTitle.trim() : "";
  const appSlogan = typeof input.appSlogan === "string" ? input.appSlogan.trim() : "";

  return {
    appTitle: (appTitle || DEFAULT_DASHBOARD_SETTINGS.appTitle).slice(0, 120),
    appSlogan: (appSlogan || DEFAULT_DASHBOARD_SETTINGS.appSlogan).slice(0, 220),
    theme: toTheme(input.theme),
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