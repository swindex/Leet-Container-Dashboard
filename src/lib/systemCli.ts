import { execFile } from "child_process";
import { promisify } from "util";
import { Client } from "ssh2";
import { isDemoMode, logDemoAction } from "./demoMode.js";
import type { DockerTargetServer } from "./dockerCli.js";

const execFileAsync = promisify(execFile);

/**
 * Executes a restart/reboot command on a remote server via SSH using sudo.
 * The command is backgrounded with a small delay so that the SSH session
 * can close cleanly before the machine actually reboots.
 * Connection drops after the command is dispatched are treated as success
 * since the server is expected to go offline.
 */
async function execRemoteRestart(server: DockerTargetServer): Promise<void> {
  if (!server.host || !server.username) {
    throw new Error("Remote server host/username is missing");
  }

  if (!server.password) {
    throw new Error("Server password is required for sudo-based restart");
  }

  const conn = new Client();

  return new Promise((resolve, reject) => {
    let stderr = "";
    let settled = false;
    let commandDispatched = false;

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      conn.end();

      // If the command was already sent and we get a connection error,
      // treat it as success — the server is rebooting as expected.
      if (error && commandDispatched) {
        resolve();
        return;
      }

      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    conn
      .on("ready", () => {
        // Use sudo -S to read password from stdin.
        // Background a delayed shutdown so SSH can return cleanly.
        const command = "sudo -S sh -c 'sleep 1 && shutdown -r now' &";

        conn.exec(command, (err, stream) => {
          if (err) {
            finish(err);
            return;
          }

          // Write the password to stdin for sudo -S
          stream.write(server.password + "\n");
          stream.end();
          commandDispatched = true;

          stream.stderr.on("data", (chunk: Buffer | string) => {
            const text = chunk.toString();
            // Ignore sudo password prompt and sudo-related messages
            if (!text.includes("[sudo]") && !text.includes("password for")) {
              stderr += text;
            }
          });

          stream.on("close", (code: number | null) => {
            // Exit code 0 or null (connection dropped) is fine
            if (code && code !== 0) {
              // Check if stderr contains actual errors vs sudo noise
              const relevantStderr = stderr.trim();
              if (relevantStderr) {
                finish(new Error(relevantStderr));
                return;
              }
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
  
  // Handle remote server restart via SSH with sudo
  if (isRemote) {
    await execRemoteRestart(server);
    return;
  }

  //Debug only: If we somehow get here with a server object that is marked as local, treat it as a local restart. This allows us to log the correct platform in demo mode without needing separate logic.
  throw new Error(`Local Machine restart requested!!!`);
  
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
