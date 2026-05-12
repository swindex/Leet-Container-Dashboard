import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAllPendingActions,
  clearCompletedPendingActions,
  getPendingAction,
  setPendingAction,
} from "../src/lib/pendingActions.js";

const serverId = "local";

describe("pending actions", () => {
  beforeEach(() => {
    clearAllPendingActions();
  });

  it("clears starting and restarting actions when containers are running", () => {
    setPendingAction(serverId, "start111", "starting");
    setPendingAction(serverId, "restart111", "restarting");

    clearCompletedPendingActions(serverId, [
      { ID: "start111", State: "running", Status: "Up 5 seconds" },
      { ID: "restart111", State: "running", Status: "Up 5 seconds" },
    ]);

    expect(getPendingAction(serverId, "start111")).toBeNull();
    expect(getPendingAction(serverId, "restart111")).toBeNull();
  });

  it("clears stopping actions when containers are stopped", () => {
    setPendingAction(serverId, "stop111", "stopping");

    clearCompletedPendingActions(serverId, [
      { ID: "stop111", State: "exited", Status: "Exited (0) 2 seconds ago" },
    ]);

    expect(getPendingAction(serverId, "stop111")).toBeNull();
  });

  it("clears removing actions when containers are gone", () => {
    setPendingAction(serverId, "remove111", "removing");

    clearCompletedPendingActions(serverId, []);

    expect(getPendingAction(serverId, "remove111")).toBeNull();
  });

  it("keeps updating actions while containers remain running", () => {
    setPendingAction(serverId, "update111", "updating");

    clearCompletedPendingActions(serverId, [
      { ID: "update111", State: "running", Status: "Up 5 seconds" },
    ]);

    expect(getPendingAction(serverId, "update111")?.action).toBe("updating");
  });
});
