import { describe, expect, it } from "vitest";
import {
  buildComposeServiceUpdateSelection,
  parseDockerLabels,
} from "../src/lib/routerHelpers.js";
import type { DockerContainer } from "../src/lib/dockerCli.js";

function container(overrides: Partial<DockerContainer>): DockerContainer {
  return {
    ID: "container-id",
    Names: "container-name",
    Image: "repo/image:latest",
    Command: "",
    CreatedAt: "",
    Labels: "",
    LocalVolumes: "",
    Mounts: "",
    Networks: "",
    Ports: "",
    RunningFor: "",
    Size: "",
    State: "running",
    Status: "Up 1 minute",
    ...overrides,
  };
}

describe("router helpers - compose service updates", () => {
  it("parses label values that contain comma-separated compose files", () => {
    const labels = parseDockerLabels(
      "com.docker.compose.project=media,com.docker.compose.service=api,com.docker.compose.project.config_files=/srv/media/docker-compose.yml,/srv/media/docker-compose.override.yml"
    );

    expect(labels["com.docker.compose.project"]).toBe("media");
    expect(labels["com.docker.compose.service"]).toBe("api");
    expect(labels["com.docker.compose.project.config_files"]).toBe(
      "/srv/media/docker-compose.yml,/srv/media/docker-compose.override.yml"
    );
  });

  it("builds deduped compose service update plans and skips standalone containers", () => {
    const containers = [
      container({
        ID: "api111",
        Names: "media-api-1",
        Labels:
          "com.docker.compose.project=media,com.docker.compose.service=api,com.docker.compose.project.working_dir=/srv/media,com.docker.compose.project.config_files=/srv/media/docker-compose.yml,/srv/media/docker-compose.override.yml",
      }),
      container({
        ID: "api222",
        Names: "media-api-2",
        Labels:
          "com.docker.compose.project=media,com.docker.compose.service=api,com.docker.compose.project.working_dir=/srv/media,com.docker.compose.project.config_files=/srv/media/docker-compose.yml,/srv/media/docker-compose.override.yml",
      }),
      container({
        ID: "worker111",
        Names: "media-worker-1",
        Labels:
          "com.docker.compose.project=media,com.docker.compose.service=worker,com.docker.compose.project.working_dir=/srv/media,com.docker.compose.project.config_files=/srv/media/docker-compose.yml,/srv/media/docker-compose.override.yml",
      }),
      container({
        ID: "standalone111",
        Names: "standalone",
        Labels: "maintainer=local",
      }),
    ];

    const selection = buildComposeServiceUpdateSelection(containers, [
      "media-api-1",
      "media-api-2",
      "media-worker-1",
      "standalone",
      "missing",
    ]);

    expect(selection.updates).toEqual([
      {
        projectName: "media",
        workingDir: "/srv/media",
        configFiles: ["/srv/media/docker-compose.yml", "/srv/media/docker-compose.override.yml"],
        services: ["api", "worker"],
      },
    ]);
    expect(selection.supportedContainers.map((item) => item.Names)).toEqual([
      "media-api-1",
      "media-api-2",
      "media-worker-1",
    ]);
    expect(selection.skipped).toEqual(["standalone"]);
    expect(selection.missing).toEqual(["missing"]);
  });

});
