import { describe, expect, it } from "vitest";

import { parseRuntimePresentation, runtimeStateLabel } from "./runtime-presentation";

const presentation = (connection: Record<string, unknown>, ready = false) =>
  parseRuntimePresentation({
    ready,
    connectionError: "",
    lastStatus: "",
    bridge: {
      contract: "a0.browser-bridge.mv3-runtime.v1",
      phase: "READY",
      connection,
      capabilities: [],
      actions: [],
      activeLeaseCount: 0,
      candidateReady: false,
    },
  });

describe("runtime activation presentation", () => {
  it("labels a development pairing-only hello without waiting for operational reconciliation", () => {
    const runtime = presentation({ state: "ready", reasonCode: "development_pairing_only", reportedServerState: "unpaired", activationReady: false });
    runtime.bridge.phase = "RECONCILING";
    expect(runtimeStateLabel(runtime)).toBe("Development pairing required");
    runtime.bridge.connection.reportedServerState = "paired";
    expect(runtimeStateLabel(runtime)).toBe("Development paired · control unavailable");
    expect(runtime.ready).toBe(false);
  });
  it("does not call a merely paired identity connected", () => {
    const runtime = presentation({
      state: "ready",
      reasonCode: "native_pairing_only",
      reportedServerState: "paired",
      serverState: "paired_inactive",
      activationReady: false,
      activationBlockers: ["extension_identity_unapproved"],
    });
    expect(runtimeStateLabel(runtime)).toBe("Activation pending");
    expect(runtime.bridge.connection.activationBlockers).toEqual(["extension_identity_unapproved"]);
  });

  it("renders connected only after the aggregate activation gate is true", () => {
    const runtime = presentation({
      state: "ready",
      reasonCode: "native_ready",
      reportedServerState: "paired",
      serverState: "paired",
      activationReady: true,
    }, true);
    expect(runtimeStateLabel(runtime)).toBe("Connected");
  });
});
