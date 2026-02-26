import { execFile } from "child_process";
import { promisify } from "util";
import { isDemoMode, logDemoAction } from "./demoMode.js";

const execFileAsync = promisify(execFile);

export async function restartHost(): Promise<void> {
  if (isDemoMode()) {
    logDemoAction("restartHost", { platform: process.platform });
    return;
  }
  
  const platform = process.platform;

  if (platform === "win32") {
    await execFileAsync("shutdown", ["/r", "/t", "0"]);
    return;
  }

  if (platform === "linux" || platform === "darwin") {
    await execFileAsync("shutdown", ["-r", "now"]);
    return;
  }

  throw new Error(`Unsupported platform for host restart: ${platform}`);
}
