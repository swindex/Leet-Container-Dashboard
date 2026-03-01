import path from "path";
import fs from "fs/promises";

const DEFAULT_DATA_DIR_NAME = "data";
const DATA_SEED_DIR_NAME = "data-seed";
const TEST_DATA_DIR_NAME = "data-test";

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

export async function ensureDataSeeded(): Promise<void> {
  const sourceDir = path.resolve(process.cwd(), DATA_SEED_DIR_NAME);
  const targetDir = getDataRootDir();

  if (path.resolve(sourceDir) === path.resolve(targetDir)) {
    console.warn(`Data seed directory ${sourceDir} is the same as target data directory. Skipping seeding.`);
    return;
  }

  await fs.mkdir(targetDir, { recursive: true });
  const targetEntries = await fs.readdir(targetDir);
  if (targetEntries.length == 0) {

    console.log(`Seeding data from ${sourceDir} to ${targetDir}...`);

    let sourceEntries: Awaited<ReturnType<typeof fs.readdir>>;
    try {
      sourceEntries = await fs.readdir(sourceDir, { withFileTypes: true });
    } catch (err) {
      console.error(`Failed to read data seed directory ${sourceDir}: ${err}`);
      return;
    }

    for (const entry of sourceEntries) {
      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);
      await fs.cp(sourcePath, targetPath, { recursive: true, force: false, errorOnExist: false });
    }

    console.log(`Data seeded from ${sourceDir} to ${targetDir}`);
  } 

  // Copy data-seed/uploads/launchpad-icons if they don't exist
  const sourceIconsDir = path.join(sourceDir, "uploads", "launchpad-icons");
  const targetIconsDir = path.join(targetDir, "uploads", "launchpad-icons");

  try {
      await fs.cp(sourceIconsDir, targetIconsDir, { recursive: true });
      console.log(`Copied launchpad icons from ${sourceIconsDir} to ${targetIconsDir}`);
  } catch (err) {
    console.error(`Failed to copy launchpad icons: ${err}`);
  }

}
