export const MV3_RUNTIME_CONTRACT = "a0.browser-bridge.mv3-runtime.v1" as const;
export const LIFECYCLE_SCHEMA_VERSION = 1 as const;

const RANDOM_BYTES = 16;
const RANDOM_HEX_LENGTH = RANDOM_BYTES * 2;
const GENERATION_PATTERN = new RegExp(`^a0g1\\.([0-9a-f]{${RANDOM_HEX_LENGTH}})$`);
const INSTALL_INSTANCE_PATTERN = new RegExp(`^a0i1\\.[0-9a-f]{${RANDOM_HEX_LENGTH}}$`);
const TAB_HANDLE_PATTERN = new RegExp(
  `^a0t1\\.([0-9a-f]{${RANDOM_HEX_LENGTH}})\\.([0-9a-f]{${RANDOM_HEX_LENGTH}})$`,
);

declare const opaqueLoadGenerationId: unique symbol;
declare const opaqueTabHandle: unique symbol;
declare const opaqueInstallInstanceId: unique symbol;
declare const opaqueWorkerBootId: unique symbol;

export type LoadGenerationId = string & { readonly [opaqueLoadGenerationId]: true };
export type TabHandle = string & { readonly [opaqueTabHandle]: true };
export type InstallInstanceId = string & { readonly [opaqueInstallInstanceId]: true };
export type WorkerBootId = string & { readonly [opaqueWorkerBootId]: true };

export type EntropySource = (length: number) => Uint8Array;

export type LifecyclePhase =
  | "BOOT"
  | "HYDRATING"
  | "RESUME_GENERATION"
  | "RESET_GENERATION"
  | "CONNECTING"
  | "NEGOTIATING"
  | "RECONCILING"
  | "READY"
  | "DISCONNECTED"
  | "RETRY_WAIT"
  | "BLOCKED"
  | "UPDATE_PENDING"
  | "DRAINING";

export interface LifecycleState {
  schemaVersion: typeof LIFECYCLE_SCHEMA_VERSION;
  contract: typeof MV3_RUNTIME_CONTRACT;
  installInstanceId: InstallInstanceId;
  loadGenerationId: LoadGenerationId;
  workerBootId: WorkerBootId;
  revision: number;
  phase: LifecyclePhase;
}

export interface PersistedLifecycleSession {
  schemaVersion: typeof LIFECYCLE_SCHEMA_VERSION;
  contract: typeof MV3_RUNTIME_CONTRACT;
  installInstanceId: InstallInstanceId;
  loadGenerationId: LoadGenerationId;
  revision: number;
}

export type BootDisposition = "resume_generation" | "reset_generation";

export interface LifecycleBootPlan {
  disposition: BootDisposition;
  state: LifecycleState;
}

export type LifecycleTransitionResult =
  | { ok: true; state: LifecycleState }
  | { ok: false; code: "REVISION_CONFLICT" | "INVALID_TRANSITION"; state: LifecycleState };

const ALLOWED_TRANSITIONS: Readonly<Record<LifecyclePhase, readonly LifecyclePhase[]>> = {
  BOOT: ["HYDRATING"],
  HYDRATING: ["RESUME_GENERATION", "RESET_GENERATION"],
  RESUME_GENERATION: ["CONNECTING"],
  RESET_GENERATION: ["CONNECTING"],
  CONNECTING: ["NEGOTIATING", "DISCONNECTED", "RETRY_WAIT", "BLOCKED"],
  NEGOTIATING: ["RECONCILING", "DISCONNECTED", "BLOCKED"],
  RECONCILING: ["READY", "DISCONNECTED", "BLOCKED"],
  READY: ["DISCONNECTED", "BLOCKED", "UPDATE_PENDING"],
  DISCONNECTED: ["CONNECTING", "RETRY_WAIT", "BLOCKED"],
  RETRY_WAIT: ["CONNECTING", "BLOCKED"],
  BLOCKED: ["CONNECTING"],
  UPDATE_PENDING: ["READY", "DRAINING", "DISCONNECTED", "BLOCKED"],
  DRAINING: ["DISCONNECTED", "BLOCKED"],
};

function secureEntropy(length: number): Uint8Array {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") {
    throw new Error("Secure randomness is unavailable.");
  }
  return cryptoApi.getRandomValues(new Uint8Array(length));
}

function randomHex(entropy: EntropySource): string {
  const bytes = entropy(RANDOM_BYTES);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== RANDOM_BYTES) {
    throw new Error(`Entropy source must return exactly ${RANDOM_BYTES} bytes.`);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createOpaqueId<T extends string>(prefix: string, entropy: EntropySource): T {
  return `${prefix}.${randomHex(entropy)}` as T;
}

export function createInstallInstanceId(entropy: EntropySource = secureEntropy): InstallInstanceId {
  return createOpaqueId<InstallInstanceId>("a0i1", entropy);
}

export function createLoadGenerationId(entropy: EntropySource = secureEntropy): LoadGenerationId {
  return createOpaqueId<LoadGenerationId>("a0g1", entropy);
}

export function createWorkerBootId(entropy: EntropySource = secureEntropy): WorkerBootId {
  return createOpaqueId<WorkerBootId>("a0w1", entropy);
}

export function isLoadGenerationId(value: unknown): value is LoadGenerationId {
  return typeof value === "string" && GENERATION_PATTERN.test(value);
}

export function createTabHandle(
  loadGenerationId: LoadGenerationId,
  entropy: EntropySource = secureEntropy,
): TabHandle {
  const generationMatch = GENERATION_PATTERN.exec(loadGenerationId);
  if (!generationMatch) {
    throw new Error("Cannot create a tab handle for an invalid load generation.");
  }
  return `a0t1.${generationMatch[1]}.${randomHex(entropy)}` as TabHandle;
}

export function parseTabHandle(
  value: unknown,
): { generationToken: string; leaseToken: string } | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = TAB_HANDLE_PATTERN.exec(value);
  return match ? { generationToken: match[1], leaseToken: match[2] } : null;
}

export function isTabHandle(value: unknown): value is TabHandle {
  return parseTabHandle(value) !== null;
}

export function tabHandleBelongsToGeneration(
  tabHandle: TabHandle,
  loadGenerationId: LoadGenerationId,
): boolean {
  const handle = parseTabHandle(tabHandle);
  const generation = GENERATION_PATTERN.exec(loadGenerationId);
  return Boolean(handle && generation && handle.generationToken === generation[1]);
}

function isPersistedLifecycleSession(value: unknown): value is PersistedLifecycleSession {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PersistedLifecycleSession>;
  return (
    candidate.schemaVersion === LIFECYCLE_SCHEMA_VERSION &&
    candidate.contract === MV3_RUNTIME_CONTRACT &&
    typeof candidate.installInstanceId === "string" &&
    INSTALL_INSTANCE_PATTERN.test(candidate.installInstanceId) &&
    isLoadGenerationId(candidate.loadGenerationId) &&
    Number.isSafeInteger(candidate.revision) &&
    Number(candidate.revision) >= 0
  );
}

export function planLifecycleBoot(input: {
  installInstanceId: InstallInstanceId;
  workerBootId: WorkerBootId;
  persistedSession?: unknown;
  newGenerationId: LoadGenerationId;
}): LifecycleBootPlan {
  const persisted = isPersistedLifecycleSession(input.persistedSession) ? input.persistedSession : null;
  const resumable = persisted?.installInstanceId === input.installInstanceId;
  const revision = resumable && persisted ? persisted.revision : 0;

  return {
    disposition: resumable ? "resume_generation" : "reset_generation",
    state: {
      schemaVersion: LIFECYCLE_SCHEMA_VERSION,
      contract: MV3_RUNTIME_CONTRACT,
      installInstanceId: input.installInstanceId,
      loadGenerationId: resumable && persisted ? persisted.loadGenerationId : input.newGenerationId,
      workerBootId: input.workerBootId,
      revision,
      phase: resumable ? "RESUME_GENERATION" : "RESET_GENERATION",
    },
  };
}

export function transitionLifecycle(
  state: LifecycleState,
  expectedRevision: number,
  phase: LifecyclePhase,
): LifecycleTransitionResult {
  if (expectedRevision !== state.revision) {
    return { ok: false, code: "REVISION_CONFLICT", state };
  }
  if (!ALLOWED_TRANSITIONS[state.phase].includes(phase)) {
    return { ok: false, code: "INVALID_TRANSITION", state };
  }
  return {
    ok: true,
    state: {
      ...state,
      phase,
      revision: state.revision + 1,
    },
  };
}

export function persistedLifecycleProjection(state: LifecycleState): PersistedLifecycleSession {
  return {
    schemaVersion: state.schemaVersion,
    contract: state.contract,
    installInstanceId: state.installInstanceId,
    loadGenerationId: state.loadGenerationId,
    revision: state.revision,
  };
}
