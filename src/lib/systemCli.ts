import { execFile } from "child_process";
import { promisify } from "util";
import { Client } from "ssh2";
import { isDemoMode, logDemoAction } from "./demoMode.js";
import type { DockerTargetServer } from "./dockerCli.js";

const execFileAsync = promisify(execFile);

async function execRemoteCommand(server: DockerTargetServer, command: string, args: string[]): Promise<void> {
  if (!server.host || !server.username) {
    throw new Error("Remote server host/username is missing");
  }

  const conn = new Client();

  return new Promise((resolve, reject) => {
    let stderr = "";
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      conn.end();
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    conn
      .on("ready", () => {
        // Build shell-escaped command
        const shellEscape = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
        const fullCommand = [command, ...args.map(shellEscape)].join(" ");

        conn.exec(fullCommand, (err, stream) => {
          if (err) {
            finish(err);
            return;
          }

          stream.stderr.on("data", (chunk: Buffer | string) => {
            stderr += chunk.toString();
          });

          stream.on("close", (code: number | null) => {
            if (code && code !== 0) {
              finish(new Error(stderr || `Remote command failed with exit code ${code}`));
              return;
            }
            finish();
          });
        });
      })
      .on("error", (error) => {
        finish(error as Error);
      })
      .connect({
        host: server.host,
        username: server.username,
        password: server.password || undefined,
        readyTimeout: 15_000,
      });
  });
}

export async function restartHost(server?: DockerTargetServer): Promise<void> {
  const targetDescription = server && !server.isLocal ? server.host : "local machine";
  const isRemote = server && !server.isLocal;
  
  if (isDemoMode()) {
    // For remote servers, log "linux" since we always use Linux shutdown commands via SSH
    // For local machine, log the actual process platform
    const platform = isRemote ? "linux" : process.platform;
    logDemoAction("restartHost", { platform, server: targetDescription });
    return;
  }
  
  // Handle remote server restart via SSH
  if (isRemote) {
    // Remote Linux/Unix systems typically use shutdown command
    await execRemoteCommand(server, "shutdown", ["-r", "now"]);
    return;
  }
  
  // Handle local machine restart
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
