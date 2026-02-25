import { execFile } from "child_process";
import { promisify } from "util";
import { Client } from "ssh2";

const execFileAsync = promisify(execFile);

const CONTAINER_ID_OR_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export type DockerTargetServer = {
  isLocal: boolean;
  host: string;
  username: string;
  password: string;
};

export interface DockerContainer {
  Command: string;
  CreatedAt: string;
  ID: string;
  Image: string;
  Labels: string;
  LocalVolumes: string;
  Mounts: string;
  Names: string;
  Networks: string;
  Ports: string;
  RunningFor: string;
  Size: string;
  State: string;
  Status: string;
  [key: string]: string;
}

async function execDocker(args: string[], server?: DockerTargetServer): Promise<string> {
  const useRemote = Boolean(server && !server.isLocal);

  try {
    const result = useRemote
      ? await execRemoteDocker(args, server!)
      : await execFileAsync("docker", args);

    return result.stdout;
  } catch (err) {
    const error = err as Error & { stderr?: string };
    throw new Error(error.stderr || error.message);
  }
}

async function execRemoteDocker(args: string[], server: DockerTargetServer): Promise<{ stdout: string; stderr: string }> {
  if (!server.host || !server.username) {
    throw new Error("Remote server host/username is missing");
  }

  return execRemoteDockerViaSsh2(server, args);
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function execRemoteDockerViaSsh2(
  server: DockerTargetServer,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  const conn = new Client();

  return new Promise((resolve, reject) => {
    let stdout = "";
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
      resolve({ stdout, stderr });
    };

    conn
      .on("ready", () => {
        const command = ["docker", ...args.map((arg) => shellEscape(arg))].join(" ");

        conn.exec(command, (err, stream) => {
          if (err) {
            finish(err);
            return;
          }

          stream.on("data", (chunk: Buffer | string) => {
            stdout += chunk.toString();
          });

          stream.stderr.on("data", (chunk: Buffer | string) => {
            stderr += chunk.toString();
          });

          stream.on("close", (code: number | null) => {
            if (code && code !== 0) {
              finish(new Error(stderr || `Remote docker command failed with exit code ${code}`));
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

export async function listRunningContainers(server?: DockerTargetServer): Promise<DockerContainer[]> {
  const out = await execDocker(["ps", "--format", "{{json .}}"], server);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DockerContainer);
}

export async function restartContainer(containerIdOrName: string, server?: DockerTargetServer): Promise<void> {
  if (!CONTAINER_ID_OR_NAME_PATTERN.test(containerIdOrName)) {
    throw new Error("Invalid container identifier.");
  }
  await execDocker(["restart", containerIdOrName], server);
}





