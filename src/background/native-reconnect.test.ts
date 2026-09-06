import { afterEach, describe, expect, it, vi } from "vitest";
import { reconnectAlarmAction } from "./native-reconnect";
import { canRetryProductionAdmission, type NativeConnectionSnapshot } from "./native-port";

const inactive = (connectionId = "one"): NativeConnectionSnapshot => ({
  state: "ready", connectionId, reasonCode: "native_pairing_only",
  reportedServerState: "paired", serverState: "paired_inactive", activationReady: false,
});

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("production admission reconnect alarms", () => {
  it("retries only the exact persisted inactive port when its bounded alarm is due", () => {
    expect(reconnectAlarmAction(inactive(), inactive(), 30_000, 30_000)).toBe("admission");
    expect(reconnectAlarmAction(inactive(), inactive(), 60_000, 30_000)).toBe("none");
    expect(reconnectAlarmAction(inactive(), inactive(), null, 30_000)).toBe("none");
    expect(reconnectAlarmAction(inactive("new"), inactive("old"), 30_000, 30_000)).toBe("none");
  });
  it.each([
    { activationReady: true, reasonCode: "native_ready" },
    { serverState: "unpaired", reportedServerState: "unpaired" },
    { state: "blocked", reasonCode: "native_hello_rejected" },
    { state: "negotiating" },
    { limitedTransportReady: true },
    { reasonCode: "development_pairing_only" },
  ] as Partial<NativeConnectionSnapshot>[])("does not retry healthy/unpaired/terminal/development states: %j", (change) => {
    const connection = { ...inactive(), ...change };
    expect(canRetryProductionAdmission(connection)).toBe(false);
    expect(reconnectAlarmAction(connection, connection, 1, 1)).toBe("none");
  });
  it("preserves ordinary host-loss recovery but not user disconnect or revocation", () => {
    for (const reasonCode of ["native_host_disconnected", "pairing_disconnected", "credential_revoked", "native_disconnect_requested"]) {
      const connection: NativeConnectionSnapshot = { state: "disconnected", reasonCode };
      expect(reconnectAlarmAction(connection, connection, 1, 1)).toBe(reasonCode === "native_host_disconnected" ? "connect" : "none");
    }
  });
  it("does not turn the development build into an automatic admission retry", async () => {
    vi.stubGlobal("__A0_LOCAL_DEVELOPMENT__", true);
    vi.resetModules();
    const { canRetryProductionAdmission: developmentPolicy } = await import("./native-port");
    expect(developmentPolicy(inactive())).toBe(false);
  });
});
