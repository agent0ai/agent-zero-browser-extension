import { BUILD_CHANNEL, DEVELOPMENT_CHANNEL, DEVELOPMENT_EXTENSION_ID } from "../build-channel";
import { hasExactKeys, isRecord, validOpaqueId } from "./rpc";

export const DEVELOPMENT_RUNTIME_CONTRACT = "a0.browser-bridge.development-runtime.v1";
export const LIMITED_BROWSER_ACTIONS = ["open", "list", "state", "navigate", "content", "scroll", "status", "ensure"] as const;
export const LIMITED_BROWSER_FEATURES = ["tab_leases_v1", "tab_groups_v1", "semantic_dom_v1", "cursor_v1"] as const;
export const LIMITED_BROWSER_METHODS = new Set([
  "browser.perform", "browser.cancel", "browser.finalize_turn", "browser.resolve_challenge", "browser.reconcile", "browser.ack_events",
]);
const TRANSPORTS = ["control", "critical_event", "operation"] as const;

export interface DevelopmentAdmission {
  contract: typeof DEVELOPMENT_RUNTIME_CONTRACT;
  channel: typeof DEVELOPMENT_CHANNEL;
  mode: "limited_runtime";
  transports: ["control", "critical_event", "operation"];
  selection_scope: "explicit_context_bridge";
  server_instance_id: string;
  bridge_id: string;
  key_generation: number;
  extension_id: typeof DEVELOPMENT_EXTENSION_ID;
  install_instance_id: string;
  load_generation_id: string;
}

export function exactCapabilities(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length
    && new Set(value).size === expected.length && expected.every((item) => value.includes(item));
}

export function parseDevelopmentAdmission(value: unknown): DevelopmentAdmission {
  const transports = isRecord(value) ? value.transports : undefined;
  if (!BUILD_CHANNEL.development || !isRecord(value) || !hasExactKeys(value, [
    "contract", "channel", "mode", "transports", "selection_scope", "server_instance_id", "bridge_id",
    "key_generation", "extension_id", "install_instance_id", "load_generation_id",
  ]) || value.contract !== DEVELOPMENT_RUNTIME_CONTRACT || value.channel !== DEVELOPMENT_CHANNEL
    || value.mode !== "limited_runtime" || value.selection_scope !== "explicit_context_bridge"
    || !Array.isArray(transports) || transports.length !== 3
    || !TRANSPORTS.every((item, index) => transports[index] === item)
    || value.extension_id !== DEVELOPMENT_EXTENSION_ID
    || ![value.server_instance_id, value.bridge_id, value.install_instance_id, value.load_generation_id].every((item) => validOpaqueId(item))
    || !Number.isSafeInteger(value.key_generation) || Number(value.key_generation) < 1) {
    throw new Error("HELLO_DEVELOPMENT_ADMISSION_INVALID");
  }
  return { ...value, transports: [...TRANSPORTS] } as DevelopmentAdmission;
}

export function developmentAdmissionIdentity(value: unknown, expected?: { installInstanceId: string; loadGenerationId: string }): string | null {
  try {
    const admission = parseDevelopmentAdmission(value);
    if (expected && (admission.install_instance_id !== expected.installInstanceId
      || admission.load_generation_id !== expected.loadGenerationId)) return null;
    return JSON.stringify([
      admission.server_instance_id, admission.bridge_id, admission.key_generation,
      admission.extension_id, admission.install_instance_id, admission.load_generation_id,
    ]);
  } catch { return null; }
}
