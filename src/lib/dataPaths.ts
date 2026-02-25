import path from "path";

const DEFAULT_DATA_DIR_NAME = "data";
const DEV_DATA_DIR_NAME = "data-secret";

function isDevMode(): boolean {
  return process.env.NODE_ENV === "development" || process.env.npm_lifecycle_event === "dev";
}

export function getDataRootDir(): string {
  const explicitDataDir = process.env.DATA_DIR?.trim();
  if (explicitDataDir) {
    return path.isAbsolute(explicitDataDir)
      ? explicitDataDir
      : path.resolve(process.cwd(), explicitDataDir);
  }

  const defaultDirName = isDevMode()
    ? DEV_DATA_DIR_NAME
    : DEFAULT_DATA_DIR_NAME;

  return path.resolve(process.cwd(), defaultDirName);
}

export function resolveDataPath(...segments: string[]): string {
  return path.resolve(getDataRootDir(), ...segments);
}
