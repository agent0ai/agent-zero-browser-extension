import { canRetryProductionAdmission, type NativeConnectionSnapshot } from "./native-port";

/** An alarm is a transport wakeup, never a request to replay browser work. */
export function reconnectAlarmAction(
  live: NativeConnectionSnapshot,
  persisted: NativeConnectionSnapshot,
  nextReconnectAtMs: number | null,
  scheduledTime: number,
): "admission" | "connect" | "none" {
  if (nextReconnectAtMs === null || scheduledTime < nextReconnectAtMs) return "none";
  if (canRetryProductionAdmission(live) && canRetryProductionAdmission(persisted)
    && live.connectionId === persisted.connectionId) return "admission";
  if (live.state !== "disconnected" || persisted.state !== "disconnected"
    || live.reasonCode !== persisted.reasonCode
    || ["pairing_disconnected", "credential_revoked", "native_disconnect_requested"].includes(live.reasonCode)) return "none";
  return "connect";
}
