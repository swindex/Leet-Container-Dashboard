import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export async function restartHost(): Promise<void> {
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
