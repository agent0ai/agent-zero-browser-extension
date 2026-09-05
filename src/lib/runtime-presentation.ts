export type RuntimePhase =
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

export type BridgePresentation = {
  contract: string;
  loadGenerationId: string;
  phase: RuntimePhase;
  connection: {
    state: "disconnected" | "connecting" | "negotiating" | "ready" | "blocked";
    reasonCode: string;
    connectionId?: string;
    companionVersion?: string;
    serverState?: string;
    reportedServerState?: string;
    activationReady?: boolean;
    limitedTransportReady?: boolean;
    activationBlockers?: string[];
    negotiatedActions?: string[];
    negotiatedFeatures?: string[];
  };
  capabilities: string[];
  actions: string[];
  activeLeaseCount: number;
  candidateReady: boolean;
};

export type RuntimePresentation = {
  ready: boolean;
  limitedBrowserReady?: boolean;
  canReconnectDevelopmentBrowser?: boolean;
  connectionError: string;
  lastStatus: string;
  bridge: BridgePresentation;
  panel: { anchorOrigin: string | null };
};

export const EMPTY_RUNTIME_PRESENTATION: RuntimePresentation = {
  ready: false,
  limitedBrowserReady: false,
  canReconnectDevelopmentBrowser: false,
  connectionError: "",
  lastStatus: "Starting browser bridge…",
  bridge: {
    contract: "a0.browser-bridge.mv3-runtime.v1",
    loadGenerationId: "",
    phase: "BOOT",
    connection: { state: "disconnected", reasonCode: "runtime_starting" },
    capabilities: [],
    actions: [],
    activeLeaseCount: 0,
    candidateReady: false,
  },
  panel: { anchorOrigin: null },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseRuntimePresentation(value: unknown): RuntimePresentation {
  if (!isRecord(value) || !isRecord(value.bridge)) {
    return EMPTY_RUNTIME_PRESENTATION;
  }
  const bridge = value.bridge;
  if (!isRecord(bridge.connection)) return EMPTY_RUNTIME_PRESENTATION;
  const connection: Record<string, unknown> = bridge.connection;
  const panel = isRecord(value.panel) ? value.panel : {};
  return {
    ready: value.ready === true,
    limitedBrowserReady: value.limitedBrowserReady === true && value.ready !== true
      && bridge.phase === "READY" && connection.state === "ready"
      && connection.activationReady === false && connection.limitedTransportReady === true,
    canReconnectDevelopmentBrowser: value.canReconnectDevelopmentBrowser === true,
    connectionError: typeof value.connectionError === "string" ? value.connectionError : "",
    lastStatus: typeof value.lastStatus === "string" ? value.lastStatus : "Browser bridge status unavailable",
    bridge: {
      contract: typeof bridge.contract === "string" ? bridge.contract : EMPTY_RUNTIME_PRESENTATION.bridge.contract,
      loadGenerationId: typeof bridge.loadGenerationId === "string" ? bridge.loadGenerationId : "",
      phase: typeof bridge.phase === "string" ? bridge.phase as RuntimePhase : "BOOT",
      connection: {
        state: typeof connection.state === "string"
          ? connection.state as BridgePresentation["connection"]["state"]
          : "disconnected",
        reasonCode: typeof connection.reasonCode === "string" ? connection.reasonCode : "status_unavailable",
        ...(typeof connection.connectionId === "string" ? { connectionId: connection.connectionId } : {}),
        ...(typeof connection.companionVersion === "string" ? { companionVersion: connection.companionVersion } : {}),
        ...(typeof connection.serverState === "string" ? { serverState: connection.serverState } : {}),
        ...(typeof connection.reportedServerState === "string" ? { reportedServerState: connection.reportedServerState } : {}),
        ...(typeof connection.activationReady === "boolean" ? { activationReady: connection.activationReady } : {}),
        ...(typeof connection.limitedTransportReady === "boolean" ? { limitedTransportReady: connection.limitedTransportReady } : {}),
        ...(Array.isArray(connection.activationBlockers)
          ? { activationBlockers: connection.activationBlockers.filter((item): item is string => typeof item === "string") }
          : {}),
        ...(Array.isArray(connection.negotiatedActions)
          ? { negotiatedActions: connection.negotiatedActions.filter((item): item is string => typeof item === "string") }
          : {}),
        ...(Array.isArray(connection.negotiatedFeatures)
          ? { negotiatedFeatures: connection.negotiatedFeatures.filter((item): item is string => typeof item === "string") }
          : {}),
      },
      capabilities: Array.isArray(bridge.capabilities)
        ? bridge.capabilities.filter((item): item is string => typeof item === "string")
        : [],
      actions: Array.isArray(bridge.actions)
        ? bridge.actions.filter((item): item is string => typeof item === "string")
        : [],
      activeLeaseCount: Number.isSafeInteger(bridge.activeLeaseCount) ? Number(bridge.activeLeaseCount) : 0,
      candidateReady: bridge.candidateReady === true,
    },
    panel: {
      anchorOrigin: typeof panel.anchorOrigin === "string" ? panel.anchorOrigin : null,
    },
  };
}

export function runtimeStateLabel(runtime: RuntimePresentation): string {
  if (runtime.limitedBrowserReady) return "Development limited browser control";
  if (runtime.bridge.connection.limitedTransportReady === true) return "Development reconciliation pending";
  if (runtime.bridge.connection.state === "ready"
    && runtime.bridge.connection.reasonCode === "development_pairing_only") {
    return runtime.bridge.connection.reportedServerState === "paired"
      ? "Development paired · control unavailable"
      : "Development pairing required";
  }
  switch (runtime.bridge.phase) {
    case "READY":
      if (runtime.bridge.connection.activationReady === true) return "Connected";
      return runtime.bridge.connection.reportedServerState === "paired"
        || runtime.bridge.connection.serverState === "paired_inactive"
        ? "Activation pending"
        : "Pairing required";
    case "CONNECTING":
    case "NEGOTIATING":
    case "RECONCILING":
      return "Connecting";
    case "RETRY_WAIT":
    case "DISCONNECTED":
      return "Companion unavailable";
    case "BLOCKED":
      return "Repair required";
    case "UPDATE_PENDING":
    case "DRAINING":
      return "Updating";
    default:
      return "Starting";
  }
}
