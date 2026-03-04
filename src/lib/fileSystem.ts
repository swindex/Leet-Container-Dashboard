/**
 * Filesystem service layer
 * Wraps all fs operations and enforces demo mode restrictions
 * Read operations are always allowed, write operations are blocked/simulated in demo mode
 */

import fsPromises from "fs/promises";
import type { Dirent } from "fs";
import { isDemoMode, logDemoAction } from "./demoMode.js";

type FileSystemOptions = {
  bypassDemoMode?: boolean;
};

/**
 * Read a file - always allowed, even in demo mode
 */
export async function readFile(
  path: string,
  encoding: BufferEncoding = "utf-8"
): Promise<string> {
  return fsPromises.readFile(path, encoding);
}

/**
 * Write a file - blocked in demo mode unless bypassDemoMode is true
 */
export async function writeFile(
  path: string,
  data: string | Buffer,
  options?: FileSystemOptions
): Promise<void> {
  if (isDemoMode() && !options?.bypassDemoMode) {
    logDemoAction("writeFile", { path, size: data.length });
    return;
  }

  await fsPromises.writeFile(path, data, "utf-8");
}

/**
 * Create directory - blocked in demo mode unless bypassDemoMode is true
 */
export async function mkdir(
  path: string,
  options?: { recursive?: boolean } & FileSystemOptions
): Promise<void> {
  if (isDemoMode() && !options?.bypassDemoMode) {
    logDemoAction("mkdir", { path, recursive: options?.recursive });
    return;
  }

  await fsPromises.mkdir(path, { recursive: options?.recursive });
}

/**
 * Read directory - always allowed, even in demo mode
 */
export async function readdir(
  path: string,
  options?: { withFileTypes?: boolean }
): Promise<string[] | Dirent[]> {
  if (options?.withFileTypes) {
    return fsPromises.readdir(path, { withFileTypes: true }) as Promise<Dirent[]>;
  }
  return fsPromises.readdir(path);
}

/**
 * Check file access - always allowed, even in demo mode
 */
export async function access(path: string): Promise<void> {
  return fsPromises.access(path);
}

/**
 * Copy file or directory - blocked in demo mode unless bypassDemoMode is true
 */
export async function cp(
  source: string,
  destination: string,
  options?: {
    recursive?: boolean;
    force?: boolean;
    errorOnExist?: boolean;
  } & FileSystemOptions
): Promise<void> {
  if (isDemoMode() && !options?.bypassDemoMode) {
    logDemoAction("cp", { 
      source, 
      destination, 
      recursive: options?.recursive,
      force: options?.force,
      errorOnExist: options?.errorOnExist
    });
    return;
  }

  await fsPromises.cp(source, destination, {
    recursive: options?.recursive,
    force: options?.force,
    errorOnExist: options?.errorOnExist,
  });
}
