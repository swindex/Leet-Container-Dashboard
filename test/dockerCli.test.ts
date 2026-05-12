import { describe, expect, it } from "vitest";
import { shouldUseSshDocker } from "../src/lib/dockerCli.js";

describe("docker CLI execution selection", () => {
  it("uses local Docker for an unconfigured local server", () => {
    expect(
      shouldUseSshDocker({
        isLocal: true,
        host: "localhost",
        username: "",
        password: "",
      })
    ).toBe(false);
  });

  it("uses local Docker for a local server even when credentials are configured", () => {
    expect(
      shouldUseSshDocker({
        isLocal: true,
        host: "192.168.1.50",
        username: "admin",
        password: "secret",
      })
    ).toBe(false);
  });

  it("uses SSH Docker for remote servers", () => {
    expect(
      shouldUseSshDocker({
        isLocal: false,
        host: "192.168.1.60",
        username: "admin",
        password: "secret",
      })
    ).toBe(true);
  });
});
