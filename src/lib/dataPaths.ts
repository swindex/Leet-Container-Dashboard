import path from "path";
import fs from "fs/promises";

const DEFAULT_DATA_DIR_NAME = "data";
const DEV_DATA_DIR_NAME = path.join("data", "secret");
const TEST_DATA_DIR_NAME = path.join("data", "test");
const DEV_BOOTSTRAP_SKIP_DIRS = new Set(["secret", "test"]);

type RuntimeMode = "development" | "test" | "production";

function getRuntimeMode(): RuntimeMode {
  if (process.env.NODE_ENV === "test" || process.env.npm_lifecycle_event === "test") {
    return "test";
  }

  if (process.env.NODE_ENV === "development" || process.env.npm_lifecycle_event === "dev") {
    return "development";
  }

  return "production";
}

function isDevMode(): boolean {
  return getRuntimeMode() === "development";
}

function getDefaultDataDirName(): string {
  const mode = getRuntimeMode();
  if (mode === "test") {
    return TEST_DATA_DIR_NAME;
  }

  if (mode === "development") {
    return DEV_DATA_DIR_NAME;
  }

  return DEFAULT_DATA_DIR_NAME;
}

export function getDataRootDir(): string {
  const explicitDataDir = process.env.DATA_DIR?.trim();
  if (explicitDataDir) {
    return path.isAbsolute(explicitDataDir)
      ? explicitDataDir
      : path.resolve(process.cwd(), explicitDataDir);
  }

  const defaultDirName = getDefaultDataDirName();

  return path.resolve(process.cwd(), defaultDirName);
}

export function resolveDataPath(...segments: string[]): string {
  return path.resolve(getDataRootDir(), ...segments);
}

export async function ensureDevDataSeeded(): Promise<void> {
  if (!isDevMode()) {
    return;
  }

  const sourceDir = path.resolve(process.cwd(), DEFAULT_DATA_DIR_NAME);
  const targetDir = getDataRootDir();

  if (path.resolve(sourceDir) === path.resolve(targetDir)) {
    return;
  }

  await fs.mkdir(targetDir, { recursive: true });
  const targetEntries = await fs.readdir(targetDir);
  if (targetEntries.length > 0) {
    return;
  }

  let sourceEntries: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    sourceEntries = await fs.readdir(sourceDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of sourceEntries) {
    if (entry.isDirectory() && DEV_BOOTSTRAP_SKIP_DIRS.has(entry.name)) {
      continue;
    }

    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    await fs.cp(sourcePath, targetPath, { recursive: true, force: false, errorOnExist: false });
  }
}
