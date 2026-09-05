import { BUILD_CHANNEL, DEVELOPMENT_CHANNEL, DEVELOPMENT_TRUST_CONTRACT } from "../build-channel";
import { parseCredentialStatus } from "./credentials";
import {
  parseDevelopmentAdmission, exactCapabilities, LIMITED_BROWSER_ACTIONS, LIMITED_BROWSER_FEATURES,
  type DevelopmentAdmission,
} from "./development-admission";
import {
  BRIDGE_CONTRACT_VERSION,
  BRIDGE_PROTOCOL,
  MAX_DIAGNOSTIC_LENGTH,
  MAX_NATIVE_MESSAGE_BYTES,
  isRecord,
  hasExactKeys,
  validOpaqueId,
} from "./rpc";
import {
  parseContextCompleteNotification,
  parseContextQueueProjection,
  parseContextEventNotification,
  parseContextSnapshotNotification,
} from "./context";
import {
  buildBrowserEventParams,
  parseBrowserAckEventsParams,
  parseBrowserEventParams,
  type BrowserEventParams,
  type CriticalBrowserEventRecord,
} from "./browser-events";
import {
  parseBrowserResolveChallengeResult,
} from "./challenges";

export const HELLO_PROTOCOL = "a0.browser-bridge" as const;
export const MAX_ARTIFACT_CHUNK_BYTES = 192 * 1024;
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

export const PROVEN_BROWSER_ACTIONS = [
  "open",
  "list",
  "state",
  "navigate",
  "content",
  "scroll",
  "screenshot",
  "hover",
  "click",
  "type",
  "upload_file",
  "status",
  "ensure",
] as const;
export const PROVEN_BROWSER_FEATURES = [
  "tab_leases_v1",
  "tab_groups_v1",
  "semantic_dom_v1",
  "cursor_v1",
  "screenshots_v1",
  "artifacts_v1",
  "trusted_input_v1",
] as const;

export const REQUIRED_BRIDGE_SCOPES = [
  "bridge.connect",
  "context.list",
  "context.read",
  "context.message",
  "browser.operate",
  "browser.control",
  "browser.artifact",
  "browser.approval",
] as const;

export type ProvenBrowserAction = (typeof PROVEN_BROWSER_ACTIONS)[number];
export type ProvenBrowserFeature = (typeof PROVEN_BROWSER_FEATURES)[number];

export class NativeSchemaError extends Error {
  constructor(public readonly reasonCode: string) {
    super(reasonCode);
    this.name = "NativeSchemaError";
  }
}

export interface HelloBuildInput {
  extensionId: string;
  extensionVersion: string;
  installInstanceId: string;
  loadGenerationId: string;
  browserFamily: "brave" | "chrome" | "chromium" | "edge" | "opera" | "vivaldi";
  browserVersion: string;
  actions: readonly string[];
  features: readonly string[];
  eventCursors: readonly { loadGenerationId: string; lastAckedEventSequence: number }[];
  inflightOpIds: readonly string[];
  leaseDigest: string;
}

export interface HelloParams {
  protocol: typeof HELLO_PROTOCOL;
  contract: { min: 1; max: 1 };
  extension: {
    id: string;
    version: string;
    manifest_version: 3;
    install_instance_id: string;
    load_generation_id: string;
  };
  browser: { family: HelloBuildInput["browserFamily"]; version: string };
  capabilities: {
    actions: ProvenBrowserAction[];
    features: ProvenBrowserFeature[];
    cdp_domains: [];
  };
  resume: {
    event_cursors: { load_generation_id: string; last_acked_event_sequence: number }[];
    inflight_op_ids: string[];
    lease_digest: string;
  };
}

export interface HelloResult {
  protocol: typeof BRIDGE_PROTOCOL;
  contractVersion: 1;
  connectionId: string;
  companion: {
    instanceId: string;
    version: string;
    platform: "darwin" | "linux" | "windows";
    arch: "aarch64" | "arm64" | "universal2" | "x86_64";
  };
  server: {
    state: "paired" | "unpaired" | "revoked" | "repair_required";
    instanceId: string | null;
    label: string;
  };
  limits: {
    maxJsonFrameBytes: number;
    artifactChunkBytes: number;
    maxArtifactBytes: number;
  };
  negotiated: {
    actions: ProvenBrowserAction[];
    features: ProvenBrowserFeature[];
  };
  activation: HelloActivationAttestation | null;
  development?: DevelopmentPairingProfile;
  developmentAdmission?: DevelopmentAdmission;
}

export interface DevelopmentPairingProfile {
  contract: typeof DEVELOPMENT_TRUST_CONTRACT;
  channel: typeof DEVELOPMENT_CHANNEL;
  connector_session_ready: false;
  browser_control_ready: false;
  reason_code: "development_runtime_not_available";
}

function parseDevelopmentProfile(value: unknown, reasonCode: string): DevelopmentPairingProfile | undefined {
  if (!BUILD_CHANNEL.development) {
    if (value !== undefined) throw new NativeSchemaError(reasonCode);
    return undefined;
  }
  if (!isRecord(value)
    || !hasExactKeys(value, ["contract", "channel", "connector_session_ready", "browser_control_ready", "reason_code"])
    || value.contract !== DEVELOPMENT_TRUST_CONTRACT
    || value.channel !== DEVELOPMENT_CHANNEL
    || value.connector_session_ready !== false
    || value.browser_control_ready !== false
    || value.reason_code !== "development_runtime_not_available") {
    throw new NativeSchemaError(reasonCode);
  }
  return {
    contract: DEVELOPMENT_TRUST_CONTRACT,
    channel: DEVELOPMENT_CHANNEL,
    connector_session_ready: false,
    browser_control_ready: false,
    reason_code: "development_runtime_not_available",
  };
}

export interface HelloActivationAttestation {
  principal: "browser_bridge";
  bridgeId: string;
  keyGeneration: number;
  extensionId: string;
  installInstanceId: string;
  serverFeatures: string[];
  rollout: "available" | "preview_authorized";
  selectedBridge: boolean;
  heartbeatFresh: boolean;
  subjectProfileBound: boolean;
  legacyControlPlaneInactive: boolean;
}

export interface LocalActivationEvidence {
  extensionIdentityApproved: boolean;
  storageMigrationState: "v1_ready" | "not_checked" | "blocked";
  chromePermissionsReady: boolean;
  legacyControlPlaneInactive: boolean;
  operationalMethodSurfaceReady: boolean;
}

export interface ActivationEvaluation {
  ready: boolean;
  blockers: string[];
}

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:[-+][0-9A-Za-z.-]+)?$/u;
const EXTENSION_ID = /^[a-p]{32}$/u;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SYMBOL = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const PAIRING_STATES = new Set([
  "uninstalled",
  "native_host_missing",
  "unpaired",
  "pairing_pending",
  "paired",
  "connecting",
  "connected",
  "reconnecting",
  "permission_required",
  "policy_blocked",
  "rotation_pending",
  "revoked",
  "repair_required",
]);
const POLICY_MODES = new Set(["ask_per_site", "allow_all_sites", "blocked"]);
const FORBIDDEN_STATUS_KEY = /(?:api.?key|authorization|cookie|credential|pairing.?code|private.?key|secret|signature|token)/iu;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

const requireRecord = (value: unknown, code: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new NativeSchemaError(code);
  return value;
};

const requireString = (value: unknown, code: string, max = 128): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new NativeSchemaError(code);
  return value;
};

const requireIdentifier = (value: unknown, code: string): string => {
  if (!validOpaqueId(value)) throw new NativeSchemaError(code);
  return value;
};

const requireSafeInteger = (value: unknown, code: string, max = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) throw new NativeSchemaError(code);
  return Number(value);
};

const requireBoolean = (value: unknown, code: string): boolean => {
  if (typeof value !== "boolean") throw new NativeSchemaError(code);
  return value;
};

const requireNullableIdentifier = (value: unknown, code: string): string | null =>
  value === null ? null : requireIdentifier(value, code);

const requireNullableSafeInteger = (value: unknown, code: string): number | null =>
  value === null ? null : requireSafeInteger(value, code);

const requireDigest = (value: unknown, code: string): string => {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) throw new NativeSchemaError(code);
  return value;
};

const requireNullableDigest = (value: unknown, code: string): string | null =>
  value === null ? null : requireDigest(value, code);

const requireEnum = <T extends string>(value: unknown, allowed: readonly T[], code: string): T => {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new NativeSchemaError(code);
  return value as T;
};

const requireHttpOrigin = (value: unknown, code: string): string => {
  const raw = requireString(value, code, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new NativeSchemaError(code);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== raw) {
    throw new NativeSchemaError(code);
  }
  return parsed.origin;
};

const requireArray = (value: unknown, code: string, max = 256): unknown[] => {
  if (!Array.isArray(value) || value.length > max) throw new NativeSchemaError(code);
  return value;
};

const uniqueSymbols = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  code: string,
): T[] => {
  const values = requireArray(value, code, 128);
  const allowedSet = new Set<string>(allowed);
  if (
    values.some((item) => typeof item !== "string" || !allowedSet.has(item)) ||
    new Set(values).size !== values.length
  ) {
    throw new NativeSchemaError(code);
  }
  return values as T[];
};

const noForbiddenStatusFields = (value: unknown, depth = 0): void => {
  if (depth > 8) throw new NativeSchemaError("STATUS_NESTING_INVALID");
  if (Array.isArray(value)) {
    for (const item of value) noForbiddenStatusFields(item, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_STATUS_KEY.test(key)) throw new NativeSchemaError("STATUS_SECRET_FIELD_FORBIDDEN");
    noForbiddenStatusFields(nested, depth + 1);
  }
};

export const normalizeServerBaseOrigin = (value: unknown): string => {
  const raw = requireString(value, "SERVER_ORIGIN_INVALID", 2_048);
  if (
    raw.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(raw) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|2e|2f|5c|7f)/iu.test(raw)
  ) {
    throw new NativeSchemaError("SERVER_ORIGIN_INVALID");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new NativeSchemaError("SERVER_ORIGIN_INVALID");
  }
  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname.endsWith(".localhost") ||
    parsed.hostname === "[::1]" ||
    /^127(?:\.[0-9]{1,3}){3}$/u.test(parsed.hostname);
  const authorityStart = raw.indexOf("://");
  const pathStart = authorityStart < 0 ? -1 : raw.indexOf("/", authorityStart + 3);
  const rawPath = pathStart < 0 ? "" : raw.slice(pathStart);
  const safePath = !rawPath.includes("%")
    && !rawPath.includes("//")
    && rawPath.split("/").filter(Boolean).every(
      (segment) => segment !== "." && segment !== ".." && /^[A-Za-z0-9._~-]+$/u.test(segment),
    );
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !safePath
  ) {
    throw new NativeSchemaError("SERVER_ORIGIN_INVALID");
  }
  const normalizedPath = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/u, "");
  return `${parsed.origin}${normalizedPath}`;
};

export const normalizePairingCode = (value: unknown): string => {
  const code = requireString(value, "PAIRING_CODE_INVALID", 160).trim().toUpperCase();
  const parts = code.split("-");
  const alphabet = /^[0-9A-HJKMNP-TV-Z]+$/u;
  const secretParts = parts.slice(2);
  if (
    parts.length < 3 ||
    parts[0] !== "A0B1" ||
    !/^[0-9A-F]{8}$/u.test(parts[1]) ||
    !secretParts.every((part) => part.length > 0 && (secretParts.length === 1 || part.length <= 8) && alphabet.test(part)) ||
    secretParts.join("").length !== 32
  ) {
    throw new NativeSchemaError("PAIRING_CODE_INVALID");
  }
  return `A0B1-${parts[1]}-${secretParts.join("")}`;
};

export const buildHelloParams = (input: HelloBuildInput): HelloParams => {
  if (!EXTENSION_ID.test(input.extensionId)) throw new NativeSchemaError("EXTENSION_ID_INVALID");
  if (!SEMVER.test(input.extensionVersion)) throw new NativeSchemaError("EXTENSION_VERSION_INVALID");
  requireIdentifier(input.installInstanceId, "INSTALL_INSTANCE_ID_INVALID");
  requireIdentifier(input.loadGenerationId, "LOAD_GENERATION_ID_INVALID");
  if (!(["brave", "chrome", "chromium", "edge", "opera", "vivaldi"] as const).includes(input.browserFamily)) {
    throw new NativeSchemaError("BROWSER_FAMILY_INVALID");
  }
  if (!/^[0-9]+(?:\.[0-9]+){0,3}$/u.test(input.browserVersion)) {
    throw new NativeSchemaError("BROWSER_VERSION_INVALID");
  }
  if (!SHA256_DIGEST.test(input.leaseDigest)) throw new NativeSchemaError("LEASE_DIGEST_INVALID");
  const actions = uniqueSymbols(input.actions, PROVEN_BROWSER_ACTIONS, "UNPROVEN_ACTION");
  const features = uniqueSymbols(input.features, PROVEN_BROWSER_FEATURES, "UNPROVEN_CAPABILITY");
  const inflightOpIds = requireArray(input.inflightOpIds, "INFLIGHT_IDS_INVALID", 256).map((id) =>
    requireIdentifier(id, "INFLIGHT_IDS_INVALID"),
  );
  if (new Set(inflightOpIds).size !== inflightOpIds.length) throw new NativeSchemaError("INFLIGHT_IDS_INVALID");
  const eventCursors = requireArray(input.eventCursors, "EVENT_CURSORS_INVALID", 8).map((cursor) => {
    const record = requireRecord(cursor, "EVENT_CURSORS_INVALID");
    return {
      load_generation_id: requireIdentifier(record.loadGenerationId, "EVENT_CURSORS_INVALID"),
      last_acked_event_sequence: requireSafeInteger(record.lastAckedEventSequence, "EVENT_CURSORS_INVALID"),
    };
  });
  if (new Set(eventCursors.map((cursor) => cursor.load_generation_id)).size !== eventCursors.length) {
    throw new NativeSchemaError("EVENT_CURSORS_INVALID");
  }

  return {
    protocol: HELLO_PROTOCOL,
    contract: { min: BRIDGE_CONTRACT_VERSION, max: BRIDGE_CONTRACT_VERSION },
    extension: {
      id: input.extensionId,
      version: input.extensionVersion,
      manifest_version: 3,
      install_instance_id: input.installInstanceId,
      load_generation_id: input.loadGenerationId,
    },
    browser: { family: input.browserFamily, version: input.browserVersion },
    capabilities: { actions, features, cdp_domains: [] },
    resume: {
      event_cursors: eventCursors,
      inflight_op_ids: inflightOpIds,
      lease_digest: input.leaseDigest,
    },
  };
};

const parseActivation = (value: unknown): HelloActivationAttestation | null => {
  if (value === undefined) return null;
  const record = requireRecord(value, "HELLO_ACTIVATION_INVALID");
  const serverFeatures = requireArray(record.server_features, "HELLO_ACTIVATION_INVALID", 32).map((feature) => {
    const parsed = requireString(feature, "HELLO_ACTIVATION_INVALID", 128);
    if (!SYMBOL.test(parsed)) throw new NativeSchemaError("HELLO_ACTIVATION_INVALID");
    return parsed;
  });
  if (new Set(serverFeatures).size !== serverFeatures.length) {
    throw new NativeSchemaError("HELLO_ACTIVATION_INVALID");
  }
  if (record.principal !== "browser_bridge" || !["available", "preview_authorized"].includes(String(record.rollout))) {
    throw new NativeSchemaError("HELLO_ACTIVATION_INVALID");
  }
  const keyGeneration = requireSafeInteger(record.key_generation, "HELLO_ACTIVATION_INVALID");
  const extensionId = requireString(record.extension_id, "HELLO_ACTIVATION_INVALID", 64);
  if (keyGeneration < 1 || !EXTENSION_ID.test(extensionId)) {
    throw new NativeSchemaError("HELLO_ACTIVATION_INVALID");
  }
  return {
    principal: "browser_bridge",
    bridgeId: requireIdentifier(record.bridge_id, "HELLO_ACTIVATION_INVALID"),
    keyGeneration,
    extensionId,
    installInstanceId: requireIdentifier(record.install_instance_id, "HELLO_ACTIVATION_INVALID"),
    serverFeatures,
    rollout: record.rollout as HelloActivationAttestation["rollout"],
    selectedBridge: requireBoolean(record.selected_bridge, "HELLO_ACTIVATION_INVALID"),
    heartbeatFresh: requireBoolean(record.heartbeat_fresh, "HELLO_ACTIVATION_INVALID"),
    subjectProfileBound: requireBoolean(record.subject_profile_bound, "HELLO_ACTIVATION_INVALID"),
    legacyControlPlaneInactive: requireBoolean(record.legacy_control_plane_inactive, "HELLO_ACTIVATION_INVALID"),
  };
};

export const parseHelloResult = (value: unknown): HelloResult => {
  noForbiddenStatusFields(value);
  const root = requireRecord(value, "HELLO_RESULT_INVALID");
  const developmentAdmission = root.development_admission === undefined ? undefined : parseDevelopmentAdmission(root.development_admission);
  const development = developmentAdmission ? undefined : parseDevelopmentProfile(root.development, "HELLO_DEVELOPMENT_INVALID");
  if ((development || developmentAdmission) && (Object.hasOwn(root, "activation")
    || (developmentAdmission && Object.hasOwn(root, "development")))) throw new NativeSchemaError("HELLO_DEVELOPMENT_INVALID");
  if (developmentAdmission && !hasExactKeys(root, ["protocol", "contract_version", "connection_id", "companion", "server", "limits", "negotiated", "development_admission"])) {
    throw new NativeSchemaError("HELLO_DEVELOPMENT_ADMISSION_INVALID");
  }
  const companion = requireRecord(root.companion, "HELLO_RESULT_INVALID");
  const server = requireRecord(root.server, "HELLO_RESULT_INVALID");
  const limits = requireRecord(root.limits, "HELLO_RESULT_INVALID");
  const platform = requireString(companion.platform, "HELLO_RESULT_INVALID");
  const arch = requireString(companion.arch, "HELLO_RESULT_INVALID");
  const serverState = requireString(server.state, "HELLO_RESULT_INVALID");
  if (root.protocol !== BRIDGE_PROTOCOL || root.contract_version !== BRIDGE_CONTRACT_VERSION) {
    throw new NativeSchemaError("VERSION_MISMATCH");
  }
  if (!SEMVER.test(requireString(companion.version, "HELLO_RESULT_INVALID", 64))) {
    throw new NativeSchemaError("HELLO_RESULT_INVALID");
  }
  if (!["darwin", "linux", "windows"].includes(platform) || !["aarch64", "arm64", "universal2", "x86_64"].includes(arch)) {
    throw new NativeSchemaError("HELLO_RESULT_INVALID");
  }
  if (!["paired", "unpaired", "revoked", "repair_required"].includes(serverState)) {
    throw new NativeSchemaError("HELLO_RESULT_INVALID");
  }
  const maxJsonFrameBytes = requireSafeInteger(limits.max_json_frame_bytes, "HELLO_LIMITS_INVALID", MAX_NATIVE_MESSAGE_BYTES);
  const artifactChunkBytes = requireSafeInteger(limits.artifact_chunk_bytes, "HELLO_LIMITS_INVALID", MAX_ARTIFACT_CHUNK_BYTES);
  const maxArtifactBytes = requireSafeInteger(limits.max_artifact_bytes, "HELLO_LIMITS_INVALID", MAX_ARTIFACT_BYTES);
  if (!maxJsonFrameBytes || !artifactChunkBytes || !maxArtifactBytes) throw new NativeSchemaError("HELLO_LIMITS_INVALID");

  const negotiated = root.negotiated === undefined ? null : requireRecord(root.negotiated, "HELLO_NEGOTIATION_INVALID");
  const serverInstanceId =
    server.instance_id === null || server.instance_id === undefined
      ? null
      : requireIdentifier(server.instance_id, "HELLO_RESULT_INVALID");
  if (serverState === "paired" && serverInstanceId === null) {
    throw new NativeSchemaError("HELLO_RESULT_INVALID");
  }
  if (developmentAdmission && (serverState !== "paired" || serverInstanceId !== developmentAdmission.server_instance_id
    || maxJsonFrameBytes !== MAX_NATIVE_MESSAGE_BYTES
    || !negotiated || !hasExactKeys(negotiated, ["actions", "features"])
    || !exactCapabilities(negotiated.actions, LIMITED_BROWSER_ACTIONS)
    || !exactCapabilities(negotiated.features, LIMITED_BROWSER_FEATURES))) {
    throw new NativeSchemaError("HELLO_DEVELOPMENT_ADMISSION_INVALID");
  }
  return {
    protocol: BRIDGE_PROTOCOL,
    contractVersion: BRIDGE_CONTRACT_VERSION,
    connectionId: requireIdentifier(root.connection_id, "HELLO_RESULT_INVALID"),
    companion: {
      instanceId: requireIdentifier(companion.instance_id, "HELLO_RESULT_INVALID"),
      version: companion.version as string,
      platform: platform as HelloResult["companion"]["platform"],
      arch: arch as HelloResult["companion"]["arch"],
    },
    server: {
      state: serverState as HelloResult["server"]["state"],
      instanceId: serverInstanceId,
      label: requireString(server.label, "HELLO_RESULT_INVALID", 128),
    },
    limits: { maxJsonFrameBytes, artifactChunkBytes, maxArtifactBytes },
    negotiated: {
      actions: negotiated ? uniqueSymbols(negotiated.actions, PROVEN_BROWSER_ACTIONS, "HELLO_NEGOTIATION_INVALID") : [],
      features: negotiated ? uniqueSymbols(negotiated.features, PROVEN_BROWSER_FEATURES, "HELLO_NEGOTIATION_INVALID") : [],
    },
    activation: parseActivation(root.activation),
    ...(development ? { development } : {}),
    ...(developmentAdmission ? { developmentAdmission } : {}),
  };
};

export const evaluateDevelopmentAdmission = (
  hello: HelloResult,
  local: LocalActivationEvidence | undefined,
  expected: Pick<HelloBuildInput, "actions" | "extensionId" | "features" | "installInstanceId" | "loadGenerationId" | "browserVersion">,
): boolean => {
  const admission = hello.developmentAdmission;
  const version = /^(\d+)\.(\d+)\.(\d+)$/u.exec(hello.companion.version);
  const chromeMajor = Number(expected.browserVersion.split(".")[0]);
  return BUILD_CHANNEL.development && !!admission && !hello.activation && !hello.development
    && admission.extension_id === expected.extensionId
    && admission.install_instance_id === expected.installInstanceId && admission.load_generation_id === expected.loadGenerationId
    && hello.server.state === "paired" && hello.server.instanceId === admission.server_instance_id
    && local?.storageMigrationState === "v1_ready" && local.chromePermissionsReady === true
    && Number.isSafeInteger(chromeMajor) && chromeMajor >= 120
    && !!version && version.slice(1).every((part) => Number.isSafeInteger(Number(part)))
    && (Number(version[1]) > 2 || (Number(version[1]) === 2 && Number(version[2]) >= 12))
    && LIMITED_BROWSER_ACTIONS.every((action) => expected.actions.includes(action))
    && LIMITED_BROWSER_FEATURES.every((feature) => expected.features.includes(feature))
    && exactCapabilities(hello.negotiated.actions, LIMITED_BROWSER_ACTIONS)
    && exactCapabilities(hello.negotiated.features, LIMITED_BROWSER_FEATURES);
};

export const evaluateActivation = (
  hello: HelloResult,
  local: LocalActivationEvidence | undefined,
  expected: Pick<HelloBuildInput, "actions" | "extensionId" | "features" | "installInstanceId">,
): ActivationEvaluation => {
  const blockers: string[] = [];
  if (hello.developmentAdmission) blockers.push("development_limited_runtime");
  if (hello.development) blockers.push("development_runtime_not_available");
  if (!local?.extensionIdentityApproved) blockers.push("extension_identity_unapproved");
  if (local?.storageMigrationState !== "v1_ready") blockers.push("storage_migration_incomplete");
  if (!local?.chromePermissionsReady) blockers.push("chrome_permissions_unverified");
  if (!local?.legacyControlPlaneInactive) blockers.push("legacy_control_plane_active");
  if (!local?.operationalMethodSurfaceReady) blockers.push("operational_method_surface_incomplete");
  if (hello.server.state !== "paired") blockers.push("server_not_paired");
  const activation = hello.activation;
  if (!activation) {
    blockers.push("server_activation_unattested");
  } else {
    if (activation.extensionId !== expected.extensionId) blockers.push("extension_identity_mismatch");
    if (activation.installInstanceId !== expected.installInstanceId) blockers.push("install_identity_mismatch");
    if (!activation.selectedBridge) blockers.push("bridge_not_selected");
    if (!activation.heartbeatFresh) blockers.push("bridge_heartbeat_stale");
    if (!activation.subjectProfileBound) blockers.push("subject_profile_mismatch");
    if (!activation.legacyControlPlaneInactive) blockers.push("server_legacy_control_plane_active");
    for (const required of ["browser_extension_bridge_v1", "connector_browser_control", "connector_browser_event"]) {
      if (!activation.serverFeatures.includes(required)) blockers.push(`server_feature_missing:${required}`);
    }
  }
  for (const action of expected.actions) {
    if (!hello.negotiated.actions.includes(action as ProvenBrowserAction)) blockers.push(`action_not_negotiated:${action}`);
  }
  for (const feature of expected.features) {
    if (!hello.negotiated.features.includes(feature as ProvenBrowserFeature)) blockers.push(`feature_not_negotiated:${feature}`);
  }
  if (hello.limits.maxJsonFrameBytes !== MAX_NATIVE_MESSAGE_BYTES) blockers.push("limit_not_negotiated:max_json_frame_bytes");
  if (hello.limits.artifactChunkBytes !== MAX_ARTIFACT_CHUNK_BYTES) blockers.push("limit_not_negotiated:artifact_chunk_bytes");
  if (hello.limits.maxArtifactBytes !== MAX_ARTIFACT_BYTES) blockers.push("limit_not_negotiated:max_artifact_bytes");
  return { ready: blockers.length === 0, blockers: [...new Set(blockers)] };
};

export interface SafeDiagnostic {
  code: string;
  message: string;
  action: string | null;
}

export interface PairingStatusResult {
  contractVersion: 1;
  state: string;
  server: { label: string; baseOrigin: string } | null;
  companion: { version: string };
  diagnostics: SafeDiagnostic[];
  development?: DevelopmentPairingProfile;
}

const parseDiagnostics = (value: unknown): SafeDiagnostic[] =>
  requireArray(value, "STATUS_DIAGNOSTICS_INVALID", 32).map((item) => {
    const record = requireRecord(item, "STATUS_DIAGNOSTICS_INVALID");
    const code = requireString(record.code, "STATUS_DIAGNOSTICS_INVALID", 128);
    if (!SYMBOL.test(code)) throw new NativeSchemaError("STATUS_DIAGNOSTICS_INVALID");
    return {
      code,
      message: requireString(record.message, "STATUS_DIAGNOSTICS_INVALID", MAX_DIAGNOSTIC_LENGTH),
      action: record.action === null || record.action === undefined
        ? null
        : requireString(record.action, "STATUS_DIAGNOSTICS_INVALID", 128),
    };
  });

export const parsePairingStatusResult = (value: unknown): PairingStatusResult => {
  noForbiddenStatusFields(value);
  const root = requireRecord(value, "PAIRING_STATUS_INVALID");
  const development = parseDevelopmentProfile(root.development, "PAIRING_DEVELOPMENT_INVALID");
  const companion = requireRecord(root.companion, "PAIRING_STATUS_INVALID");
  const state = requireString(root.state, "PAIRING_STATUS_INVALID");
  if (root.contract_version !== BRIDGE_CONTRACT_VERSION || !PAIRING_STATES.has(state)) {
    throw new NativeSchemaError("PAIRING_STATUS_INVALID");
  }
  let server: PairingStatusResult["server"] = null;
  if (root.server !== null) {
    const record = requireRecord(root.server, "PAIRING_STATUS_INVALID");
    server = {
      label: requireString(record.label, "PAIRING_STATUS_INVALID", 128),
      baseOrigin: normalizeServerBaseOrigin(record.base_origin),
    };
  }
  const version = requireString(companion.version, "PAIRING_STATUS_INVALID", 64);
  if (!SEMVER.test(version)) throw new NativeSchemaError("PAIRING_STATUS_INVALID");
  return {
    contractVersion: BRIDGE_CONTRACT_VERSION,
    state,
    server,
    companion: { version },
    diagnostics: parseDiagnostics(root.diagnostics),
    ...(development ? { development } : {}),
  };
};

export const buildPairingStatusParams = (): Record<string, unknown> => ({ contract_version: BRIDGE_CONTRACT_VERSION });

export const buildPairingExchangeParams = (input: {
  pairingCode: string;
  serverBaseOrigin: string;
}): Record<string, unknown> => ({
  contract_version: BRIDGE_CONTRACT_VERSION,
  pairing_code: normalizePairingCode(input.pairingCode),
  server_base_origin: normalizeServerBaseOrigin(input.serverBaseOrigin),
});

export interface PairingExchangeResult {
  contractVersion: 1;
  state: "paired";
  bridgeId: string;
  server: { instanceId: string; label: string; baseOrigin: string };
  scopes: string[];
  policy: { mode: string; ready: boolean };
  development?: DevelopmentPairingProfile;
}

export const parsePairingExchangeResult = (value: unknown): PairingExchangeResult => {
  noForbiddenStatusFields(value);
  const root = requireRecord(value, "PAIRING_EXCHANGE_INVALID");
  const development = parseDevelopmentProfile(root.development, "PAIRING_DEVELOPMENT_INVALID");
  const server = requireRecord(root.server, "PAIRING_EXCHANGE_INVALID");
  const policy = requireRecord(root.policy, "PAIRING_EXCHANGE_INVALID");
  const scopes = requireArray(root.scopes, "PAIRING_EXCHANGE_INVALID", 16).map((scope) =>
    requireString(scope, "PAIRING_EXCHANGE_INVALID", 64),
  );
  if (
    root.contract_version !== BRIDGE_CONTRACT_VERSION ||
    root.state !== "paired" ||
    scopes.length !== REQUIRED_BRIDGE_SCOPES.length ||
    REQUIRED_BRIDGE_SCOPES.some((scope) => !scopes.includes(scope)) ||
    !POLICY_MODES.has(String(policy.mode))
    || (development && policy.ready !== false)
  ) {
    throw new NativeSchemaError("PAIRING_EXCHANGE_INVALID");
  }
  return {
    contractVersion: BRIDGE_CONTRACT_VERSION,
    state: "paired",
    bridgeId: requireIdentifier(root.bridge_id, "PAIRING_EXCHANGE_INVALID"),
    server: {
      instanceId: requireIdentifier(server.instance_id, "PAIRING_EXCHANGE_INVALID"),
      label: requireString(server.label, "PAIRING_EXCHANGE_INVALID", 128),
      baseOrigin: normalizeServerBaseOrigin(server.base_origin),
    },
    scopes,
    policy: {
      mode: String(policy.mode),
      ready: requireBoolean(policy.ready, "PAIRING_EXCHANGE_INVALID"),
    },
    ...(development ? { development } : {}),
  };
};

export interface AgentStatusResult {
  contractVersion: 1;
  server: {
    state: "reachable" | "unreachable" | "revoked";
    version: string | null;
    instanceId: string;
    label: string;
  };
  activeContextCount: number;
  selectedBackend: { id: string | null; ready: boolean };
  policy: { mode: string; ready: boolean };
  diagnostics: SafeDiagnostic[];
}

export const parseAgentStatusResult = (value: unknown): AgentStatusResult => {
  noForbiddenStatusFields(value);
  const root = requireRecord(value, "AGENT_STATUS_INVALID");
  const server = requireRecord(root.server, "AGENT_STATUS_INVALID");
  const active = requireRecord(root.active_contexts, "AGENT_STATUS_INVALID");
  const backend = requireRecord(root.selected_browser_backend, "AGENT_STATUS_INVALID");
  const policy = requireRecord(root.policy, "AGENT_STATUS_INVALID");
  if (
    root.contract_version !== BRIDGE_CONTRACT_VERSION ||
    !["reachable", "unreachable", "revoked"].includes(String(server.state)) ||
    !POLICY_MODES.has(String(policy.mode))
  ) {
    throw new NativeSchemaError("AGENT_STATUS_INVALID");
  }
  const version = server.version === null ? null : requireString(server.version, "AGENT_STATUS_INVALID", 64);
  if (version !== null && !SEMVER.test(version)) throw new NativeSchemaError("AGENT_STATUS_INVALID");
  return {
    contractVersion: BRIDGE_CONTRACT_VERSION,
    server: {
      state: server.state as AgentStatusResult["server"]["state"],
      version,
      instanceId: requireIdentifier(server.instance_id, "AGENT_STATUS_INVALID"),
      label: requireString(server.label, "AGENT_STATUS_INVALID", 128),
    },
    activeContextCount: requireSafeInteger(active.count, "AGENT_STATUS_INVALID", 256),
    selectedBackend: {
      id: backend.id === null ? null : requireIdentifier(backend.id, "AGENT_STATUS_INVALID"),
      ready: requireBoolean(backend.ready, "AGENT_STATUS_INVALID"),
    },
    policy: {
      mode: String(policy.mode),
      ready: requireBoolean(policy.ready, "AGENT_STATUS_INVALID"),
    },
    diagnostics: parseDiagnostics(root.diagnostics),
  };
};

export interface BrowserReconcileRequest {
  contract_version: 1;
  control_id: string;
  expected_contexts: {
    context_id: string;
    browser_session_id: string;
    active_turn_ids: string[];
  }[];
  event_cursors: { load_generation_id: string; last_acked_event_sequence: number }[];
  known_control_ids: string[];
}

export const parseBrowserReconcileRequest = (value: unknown): BrowserReconcileRequest => {
  noForbiddenStatusFields(value);
  const root = requireRecord(value, "RECONCILE_REQUEST_INVALID");
  if (root.contract_version !== BRIDGE_CONTRACT_VERSION) throw new NativeSchemaError("VERSION_MISMATCH");
  const parsed: BrowserReconcileRequest = {
    contract_version: BRIDGE_CONTRACT_VERSION,
    control_id: requireIdentifier(root.control_id, "RECONCILE_REQUEST_INVALID"),
    expected_contexts: requireArray(root.expected_contexts, "RECONCILE_REQUEST_INVALID", 128).map((item) => {
      const context = requireRecord(item, "RECONCILE_REQUEST_INVALID");
      return {
        context_id: requireIdentifier(context.context_id, "RECONCILE_REQUEST_INVALID"),
        browser_session_id: requireIdentifier(context.browser_session_id, "RECONCILE_REQUEST_INVALID"),
        active_turn_ids: requireArray(context.active_turn_ids, "RECONCILE_REQUEST_INVALID", 32).map((turn) =>
          requireIdentifier(turn, "RECONCILE_REQUEST_INVALID"),
        ),
      };
    }),
    event_cursors: requireArray(root.event_cursors, "RECONCILE_REQUEST_INVALID", 16).map((item) => {
      const cursor = requireRecord(item, "RECONCILE_REQUEST_INVALID");
      return {
        load_generation_id: requireIdentifier(cursor.load_generation_id, "RECONCILE_REQUEST_INVALID"),
        last_acked_event_sequence: requireSafeInteger(cursor.last_acked_event_sequence, "RECONCILE_REQUEST_INVALID"),
      };
    }),
    known_control_ids: requireArray(root.known_control_ids, "RECONCILE_REQUEST_INVALID", 2_048).map((control) =>
      requireIdentifier(control, "RECONCILE_REQUEST_INVALID"),
    ),
  };
  if (
    new Set(parsed.expected_contexts.map((context) => context.context_id)).size !== parsed.expected_contexts.length ||
    parsed.expected_contexts.some((context) => new Set(context.active_turn_ids).size !== context.active_turn_ids.length) ||
    new Set(parsed.event_cursors.map((cursor) => cursor.load_generation_id)).size !== parsed.event_cursors.length ||
    new Set(parsed.known_control_ids).size !== parsed.known_control_ids.length
  ) {
    throw new NativeSchemaError("RECONCILE_REQUEST_INVALID");
  }
  return parsed;
};

export interface BrowserReconcileResult {
  contract_version: 1;
  control_id: string;
  install_instance_id: string;
  load_generation_id: string;
  leases: BrowserReconcileLease[];
  inflight_operations: BrowserReconcileInflightOperation[];
  terminal_action_receipts: BrowserReconcileTerminalReceipt[];
  pending_critical_events: BrowserReconcileCriticalEvent[];
  prior_generation_orphans: BrowserReconcileOrphan[];
}

export interface BrowserReconcileBuildInput {
  controlId: string;
  installInstanceId: string;
  loadGenerationId: string;
  leases: readonly unknown[];
  inflightOperations: readonly unknown[];
  terminalActionReceipts: readonly unknown[];
  pendingCriticalEvents: readonly unknown[];
  priorGenerationOrphans: readonly unknown[];
}

const LEASE_ORIGINS = ["created", "claimed"] as const;
const LEASE_DISPOSITIONS = ["ephemeral", "deliverable", "handoff"] as const;
const LEASE_STATES = ["active", "finalizing", "closed", "released", "retained", "outcome_unknown", "orphan"] as const;
const TAKEOVER_REASONS = ["moved", "pinned", "unpinned", "ungrouped", "regrouped", "shared_group", "window_changed", "other"] as const;
const RETENTION_REASONS = [
  "user_takeover",
  "claimed_tab",
  "non_ephemeral",
  "generation_mismatch",
  "handle_mismatch",
  "context_mismatch",
  "browser_session_mismatch",
  "turn_mismatch",
  "control_mismatch",
  "identity_mismatch",
  "tab_missing",
  "protected",
  "ambiguous",
  "unresolved_reconciliation",
  "not_active",
  "outcome_unknown",
] as const;
const NONTERMINAL_STAGES = ["prepared", "waiting_approval", "effect_started"] as const;
const TERMINAL_STAGES = ["succeeded", "failed", "canceled", "outcome_unknown"] as const;
const MUTATION_OUTCOMES = ["not_applied", "applied", "unknown"] as const;
type NullableEnum<T extends readonly string[]> = T[number] | null;

export interface BrowserReconcileLease {
  lease_id: string;
  tab_handle: string;
  load_generation_id: string;
  context_id: string;
  browser_session_id: string;
  turn_id: string;
  origin: (typeof LEASE_ORIGINS)[number];
  disposition: (typeof LEASE_DISPOSITIONS)[number];
  state: (typeof LEASE_STATES)[number];
  site_origin: string;
  identity: {
    browser_instance_id: string;
    provider_tab_id: number;
    provider_window_id: number;
    document_id: string | null;
    document_epoch: number;
  };
  group_intent_id: string | null;
  provider_group_id: number | null;
  finalization_control_id: string | null;
  user_intervened: boolean;
  user_takeover_reason: NullableEnum<typeof TAKEOVER_REASONS>;
  is_protected: boolean;
  is_ambiguous: boolean;
  unresolved_reconciliation: boolean;
  overlay_attached: boolean;
  debugger_attached: boolean;
  retention_reason: NullableEnum<typeof RETENTION_REASONS>;
  revision: number;
}

export interface BrowserReconcileInflightOperation {
  load_generation_id: string;
  action_id: string;
  kind: string;
  canonical_parameter_hash: string;
  stage: (typeof NONTERMINAL_STAGES)[number];
  created_at_ms: number;
  updated_at_ms: number;
}

export interface BrowserReconcileTerminalReceipt {
  load_generation_id: string;
  action_id: string;
  kind: string;
  canonical_parameter_hash: string;
  stage: (typeof TERMINAL_STAGES)[number];
  safe_receipt: {
    outcome: (typeof MUTATION_OUTCOMES)[number];
    code: string | null;
    lease_handle_digest: string | null;
  };
  created_at_ms: number;
  updated_at_ms: number;
  acknowledged_at_ms: number | null;
}

export type BrowserReconcileCriticalEvent = BrowserEventParams;

export interface BrowserReconcileOrphan {
  load_generation_id: string;
  lease_handle_digest: string;
  exact_identity_digest: string;
  browser_instance_id: string;
  provider_tab_id: number;
  provider_window_id: number;
  provider_group_id: number | null;
  context_id: string;
  browser_session_id: string;
  turn_id: string;
  origin: (typeof LEASE_ORIGINS)[number];
  disposition: (typeof LEASE_DISPOSITIONS)[number];
  state: "orphan";
  url_identity: { origin: string; path_digest: string };
  user_intervened: boolean;
  finalization_control_id: string | null;
  retention_reason: NullableEnum<typeof RETENTION_REASONS>;
  updated_at_ms: number;
}

const requireNullableSymbol = (value: unknown, code: string): string | null => {
  if (value === null) return null;
  const parsed = requireString(value, code, 64);
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(parsed)) throw new NativeSchemaError(code);
  return parsed;
};

const parseReconcileLease = (value: unknown): BrowserReconcileLease => {
  const code = "RECONCILE_RESULT_INVALID";
  const record = requireRecord(value, code);
  noForbiddenStatusFields(record);
  const identity = requireRecord(record.identity, code);
  return {
    lease_id: requireIdentifier(record.lease_id, code),
    tab_handle: requireIdentifier(record.tab_handle, code),
    load_generation_id: requireIdentifier(record.load_generation_id, code),
    context_id: requireIdentifier(record.context_id, code),
    browser_session_id: requireIdentifier(record.browser_session_id, code),
    turn_id: requireIdentifier(record.turn_id, code),
    origin: requireEnum(record.origin, LEASE_ORIGINS, code),
    disposition: requireEnum(record.disposition, LEASE_DISPOSITIONS, code),
    state: requireEnum(record.state, LEASE_STATES, code),
    site_origin: requireHttpOrigin(record.site_origin, code),
    identity: {
      browser_instance_id: requireIdentifier(identity.browser_instance_id, code),
      provider_tab_id: requireSafeInteger(identity.provider_tab_id, code),
      provider_window_id: requireSafeInteger(identity.provider_window_id, code),
      document_id: requireNullableIdentifier(identity.document_id, code),
      document_epoch: requireSafeInteger(identity.document_epoch, code),
    },
    group_intent_id: requireNullableIdentifier(record.group_intent_id, code),
    provider_group_id: requireNullableSafeInteger(record.provider_group_id, code),
    finalization_control_id: requireNullableIdentifier(record.finalization_control_id, code),
    user_intervened: requireBoolean(record.user_intervened, code),
    user_takeover_reason: record.user_takeover_reason === null
      ? null
      : requireEnum(record.user_takeover_reason, TAKEOVER_REASONS, code),
    is_protected: requireBoolean(record.is_protected, code),
    is_ambiguous: requireBoolean(record.is_ambiguous, code),
    unresolved_reconciliation: requireBoolean(record.unresolved_reconciliation, code),
    overlay_attached: requireBoolean(record.overlay_attached, code),
    debugger_attached: requireBoolean(record.debugger_attached, code),
    retention_reason: record.retention_reason === null
      ? null
      : requireEnum(record.retention_reason, RETENTION_REASONS, code),
    revision: requireSafeInteger(record.revision, code),
  };
};

const parseInflightOperation = (value: unknown): BrowserReconcileInflightOperation => {
  const code = "RECONCILE_RESULT_INVALID";
  const record = requireRecord(value, code);
  noForbiddenStatusFields(record);
  return {
    load_generation_id: requireIdentifier(record.load_generation_id, code),
    action_id: requireIdentifier(record.action_id, code),
    kind: requireString(record.kind, code, 128),
    canonical_parameter_hash: requireDigest(record.canonical_parameter_hash, code),
    stage: requireEnum(record.stage, NONTERMINAL_STAGES, code),
    created_at_ms: requireSafeInteger(record.created_at_ms, code),
    updated_at_ms: requireSafeInteger(record.updated_at_ms, code),
  };
};

const parseTerminalReceipt = (value: unknown): BrowserReconcileTerminalReceipt => {
  const code = "RECONCILE_RESULT_INVALID";
  const record = requireRecord(value, code);
  noForbiddenStatusFields(record);
  const receipt = requireRecord(record.safe_receipt, code);
  return {
    load_generation_id: requireIdentifier(record.load_generation_id, code),
    action_id: requireIdentifier(record.action_id, code),
    kind: requireString(record.kind, code, 128),
    canonical_parameter_hash: requireDigest(record.canonical_parameter_hash, code),
    stage: requireEnum(record.stage, TERMINAL_STAGES, code),
    safe_receipt: {
      outcome: requireEnum(receipt.outcome, MUTATION_OUTCOMES, code),
      code: requireNullableSymbol(receipt.code, code),
      lease_handle_digest: requireNullableDigest(receipt.lease_handle_digest, code),
    },
    created_at_ms: requireSafeInteger(record.created_at_ms, code),
    updated_at_ms: requireSafeInteger(record.updated_at_ms, code),
    acknowledged_at_ms: requireNullableSafeInteger(record.acknowledged_at_ms, code),
  };
};

const parseCriticalEvent = (value: unknown): BrowserReconcileCriticalEvent => {
  try {
    return buildBrowserEventParams(parseBrowserEventParams(value));
  } catch {
    throw new NativeSchemaError("RECONCILE_RESULT_INVALID");
  }
};

const parseOrphan = (value: unknown): BrowserReconcileOrphan => {
  const code = "RECONCILE_RESULT_INVALID";
  const record = requireRecord(value, code);
  noForbiddenStatusFields(record);
  const urlIdentity = requireRecord(record.url_identity, code);
  if (record.state !== "orphan") throw new NativeSchemaError(code);
  return {
    load_generation_id: requireIdentifier(record.load_generation_id, code),
    lease_handle_digest: requireDigest(record.lease_handle_digest, code),
    exact_identity_digest: requireDigest(record.exact_identity_digest, code),
    browser_instance_id: requireIdentifier(record.browser_instance_id, code),
    provider_tab_id: requireSafeInteger(record.provider_tab_id, code),
    provider_window_id: requireSafeInteger(record.provider_window_id, code),
    provider_group_id: requireNullableSafeInteger(record.provider_group_id, code),
    context_id: requireIdentifier(record.context_id, code),
    browser_session_id: requireIdentifier(record.browser_session_id, code),
    turn_id: requireIdentifier(record.turn_id, code),
    origin: requireEnum(record.origin, LEASE_ORIGINS, code),
    disposition: requireEnum(record.disposition, LEASE_DISPOSITIONS, code),
    state: "orphan",
    url_identity: {
      origin: requireHttpOrigin(urlIdentity.origin, code),
      path_digest: requireDigest(urlIdentity.path_digest, code),
    },
    user_intervened: requireBoolean(record.user_intervened, code),
    finalization_control_id: requireNullableIdentifier(record.finalization_control_id, code),
    retention_reason: record.retention_reason === null
      ? null
      : requireEnum(record.retention_reason, RETENTION_REASONS, code),
    updated_at_ms: requireSafeInteger(record.updated_at_ms, code),
  };
};

const projectLease = (value: unknown): BrowserReconcileLease => {
  const code = "RECONCILE_RESULT_INVALID";
  const record = requireRecord(value, code);
  const identity = requireRecord(record.identity, code);
  return parseReconcileLease({
    lease_id: record.leaseId,
    tab_handle: record.tabHandle,
    load_generation_id: record.loadGenerationId,
    context_id: record.contextId,
    browser_session_id: record.browserSessionId,
    turn_id: record.turnId,
    origin: record.origin,
    disposition: record.disposition,
    state: record.state,
    site_origin: record.siteOrigin,
    identity: {
      browser_instance_id: identity.browserInstanceId,
      provider_tab_id: identity.providerTabId,
      provider_window_id: identity.providerWindowId,
      document_id: identity.documentId,
      document_epoch: identity.documentEpoch,
    },
    group_intent_id: record.groupIntentId,
    provider_group_id: record.providerGroupId,
    finalization_control_id: record.finalizationControlId,
    user_intervened: record.userIntervened,
    user_takeover_reason: record.userTakeoverReason,
    is_protected: record.isProtected,
    is_ambiguous: record.isAmbiguous,
    unresolved_reconciliation: record.unresolvedReconciliation,
    overlay_attached: record.overlayAttached,
    debugger_attached: record.debuggerAttached,
    retention_reason: record.retentionReason,
    revision: record.revision,
  });
};

const projectInflightOperation = (value: unknown): BrowserReconcileInflightOperation => {
  const code = "RECONCILE_RESULT_INVALID";
  const record = requireRecord(value, code);
  return parseInflightOperation({
    load_generation_id: record.loadGenerationId,
    action_id: record.actionId,
    kind: record.kind,
    canonical_parameter_hash: record.canonicalParameterHash,
    stage: record.stage,
    created_at_ms: record.createdAt,
    updated_at_ms: record.updatedAt,
  });
};

const projectTerminalReceipt = (value: unknown): BrowserReconcileTerminalReceipt => {
  const code = "RECONCILE_RESULT_INVALID";
  const record = requireRecord(value, code);
  const receipt = requireRecord(record.safeReceipt, code);
  return parseTerminalReceipt({
    load_generation_id: record.loadGenerationId,
    action_id: record.actionId,
    kind: record.kind,
    canonical_parameter_hash: record.canonicalParameterHash,
    stage: record.stage,
    safe_receipt: {
      outcome: receipt.outcome,
      code: receipt.code,
      lease_handle_digest: receipt.leaseHandleDigest,
    },
    created_at_ms: record.createdAt,
    updated_at_ms: record.updatedAt,
    acknowledged_at_ms: record.acknowledgedAt,
  });
};

const projectCriticalEvent = (value: unknown): BrowserReconcileCriticalEvent => {
  const code = "RECONCILE_RESULT_INVALID";
  const record = requireRecord(value, code);
  try {
    return buildBrowserEventParams(record as unknown as CriticalBrowserEventRecord);
  } catch {
    throw new NativeSchemaError(code);
  }
};

const projectOrphan = (value: unknown): BrowserReconcileOrphan => {
  const code = "RECONCILE_RESULT_INVALID";
  const record = requireRecord(value, code);
  const urlIdentity = requireRecord(record.urlIdentity, code);
  return parseOrphan({
    load_generation_id: record.loadGenerationId,
    lease_handle_digest: record.leaseHandleDigest,
    exact_identity_digest: record.exactIdentityDigest,
    browser_instance_id: record.browserInstanceId,
    provider_tab_id: record.providerTabId,
    provider_window_id: record.providerWindowId,
    provider_group_id: record.providerGroupId,
    context_id: record.contextId,
    browser_session_id: record.browserSessionId,
    turn_id: record.turnId,
    origin: record.origin,
    disposition: record.disposition,
    state: record.state,
    url_identity: {
      origin: urlIdentity.origin,
      path_digest: urlIdentity.pathDigest,
    },
    user_intervened: record.userIntervened,
    finalization_control_id: record.finalizationControlId,
    retention_reason: record.retentionReason,
    updated_at_ms: record.updatedAt,
  });
};

export const buildBrowserReconcileResult = (input: BrowserReconcileBuildInput): BrowserReconcileResult =>
  parseBrowserReconcileResult({
    contract_version: BRIDGE_CONTRACT_VERSION,
    control_id: input.controlId,
    install_instance_id: input.installInstanceId,
    load_generation_id: input.loadGenerationId,
    leases: requireArray(input.leases, "RECONCILE_RESULT_INVALID", 512).map(projectLease),
    inflight_operations: requireArray(input.inflightOperations, "RECONCILE_RESULT_INVALID", 256).map(projectInflightOperation),
    terminal_action_receipts: requireArray(input.terminalActionReceipts, "RECONCILE_RESULT_INVALID", 2_048).map(projectTerminalReceipt),
    pending_critical_events: requireArray(input.pendingCriticalEvents, "RECONCILE_RESULT_INVALID", 1_024).map(projectCriticalEvent),
    prior_generation_orphans: requireArray(input.priorGenerationOrphans, "RECONCILE_RESULT_INVALID", 512).map(projectOrphan),
  });

export const parseBrowserReconcileResult = (value: unknown): BrowserReconcileResult => {
  noForbiddenStatusFields(value);
  const root = requireRecord(value, "RECONCILE_RESULT_INVALID");
  if (root.contract_version !== BRIDGE_CONTRACT_VERSION) throw new NativeSchemaError("VERSION_MISMATCH");
  const parsed: BrowserReconcileResult = {
    contract_version: BRIDGE_CONTRACT_VERSION,
    control_id: requireIdentifier(root.control_id, "RECONCILE_RESULT_INVALID"),
    install_instance_id: requireIdentifier(root.install_instance_id, "RECONCILE_RESULT_INVALID"),
    load_generation_id: requireIdentifier(root.load_generation_id, "RECONCILE_RESULT_INVALID"),
    leases: requireArray(root.leases, "RECONCILE_RESULT_INVALID", 512).map(parseReconcileLease),
    inflight_operations: requireArray(root.inflight_operations, "RECONCILE_RESULT_INVALID", 256).map(parseInflightOperation),
    terminal_action_receipts: requireArray(root.terminal_action_receipts, "RECONCILE_RESULT_INVALID", 2_048).map(parseTerminalReceipt),
    pending_critical_events: requireArray(root.pending_critical_events, "RECONCILE_RESULT_INVALID", 1_024).map(parseCriticalEvent),
    prior_generation_orphans: requireArray(root.prior_generation_orphans, "RECONCILE_RESULT_INVALID", 512).map(parseOrphan),
  };
  if (
    parsed.leases.some((lease) => lease.load_generation_id !== parsed.load_generation_id) ||
    new Set(parsed.leases.map((lease) => lease.lease_id)).size !== parsed.leases.length ||
    new Set(parsed.leases.map((lease) => lease.tab_handle)).size !== parsed.leases.length ||
    new Set(parsed.inflight_operations.map((operation) => operation.action_id)).size !== parsed.inflight_operations.length ||
    new Set(parsed.terminal_action_receipts.map((receipt) => receipt.action_id)).size !== parsed.terminal_action_receipts.length ||
    parsed.pending_critical_events.some((event) => event.event_sequence < 1) ||
    new Set(parsed.pending_critical_events.map((event) => `${event.load_generation_id}:${event.event_sequence}`)).size !==
      parsed.pending_critical_events.length ||
    parsed.prior_generation_orphans.some((orphan) => orphan.load_generation_id === parsed.load_generation_id) ||
    new Set(parsed.prior_generation_orphans.map((orphan) => orphan.lease_handle_digest)).size !==
      parsed.prior_generation_orphans.length
  ) {
    throw new NativeSchemaError("RECONCILE_RESULT_INVALID");
  }
  return parsed;
};

export const isPrivilegedBrowserMethod = (method: string): boolean =>
  method === "browser.perform" ||
  method === "browser.cancel" ||
  method === "browser.finalize_turn" ||
  method === "browser.resolve_challenge" ||
  method === "browser.ack_events" ||
  method.startsWith("artifact.");

export const parseInboundParams = (method: string, params: Record<string, unknown>): Record<string, unknown> => {
  if (method === "browser.reconcile") return { ...parseBrowserReconcileRequest(params) };
  if (method === "browser.ack_events") return { ...parseBrowserAckEventsParams(params) };
  if (method === "context.snapshot") return { ...parseContextSnapshotNotification(params) };
  if (method === "context.event") return { ...parseContextEventNotification(params) };
  if (method === "context.complete") return { ...parseContextCompleteNotification(params) };
  if (method === "context.queue_updated") return { ...parseContextQueueProjection(params) };
  if (method === "credential.changed") return { ...parseCredentialStatus(params, "revoke") };
  return params;
};

export const parseOutboundResult = (method: string, result: Record<string, unknown>): Record<string, unknown> => {
  if (method === "browser.reconcile") return { ...parseBrowserReconcileResult(result) };
  if (method === "browser.resolve_challenge") return { ...parseBrowserResolveChallengeResult(result) };
  return result;
};
