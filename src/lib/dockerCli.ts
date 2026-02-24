import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const CONTAINER_ID_OR_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

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

async function execDocker(args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("docker", args);
    if (stderr) {
      throw new Error(stderr);
    }
    return stdout;
  } catch (err) {
    const error = err as Error & { stderr?: string };
    throw new Error(error.stderr || error.message);
  }
}

export async function listRunningContainers(): Promise<DockerContainer[]> {
  const out = await execDocker(["ps", "--format", "{{json .}}"]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DockerContainer);
}

export async function restartContainer(containerIdOrName: string): Promise<void> {
  if (!CONTAINER_ID_OR_NAME_PATTERN.test(containerIdOrName)) {
    throw new Error("Invalid container identifier.");
  }
  await execDocker(["restart", containerIdOrName]);
}


