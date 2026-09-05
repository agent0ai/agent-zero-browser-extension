import { markLeaseUserTakeover, type TabLease } from "./leases";
import type { LoadGenerationId } from "./lifecycle";

export type AgentGroupColor = "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange";

export interface ProviderGroupBinding {
  providerWindowId: number;
  providerGroupId: number;
}

export interface TaskGroupIntent {
  intentId: string;
  loadGenerationId: LoadGenerationId;
  browserSessionId: string;
  title: string;
  color: AgentGroupColor;
  providerGroupsByWindow: Readonly<Record<string, ProviderGroupBinding>>;
  revision: number;
}

export type GroupBindingResult =
  | { ok: true; intent: TaskGroupIntent; binding: ProviderGroupBinding; disposition: "created" | "existing" }
  | { ok: false; code: "GROUP_BINDING_CONFLICT"; intent: TaskGroupIntent; existing: ProviderGroupBinding };

export type GroupPlacementPlan =
  | { action: "create_and_join"; providerWindowId: number; title: string; color: AgentGroupColor }
  | { action: "join_existing"; providerWindowId: number; providerGroupId: number }
  | { action: "preserve_user_location"; reason: "claimed_tab" }
  | {
      action: "retain_tab";
      reason: "generation_mismatch" | "browser_session_mismatch" | "intent_mismatch" | "lease_not_active";
    };

export interface GroupRegistry {
  readonly intentsByBrowserSession: Readonly<Record<string, TaskGroupIntent>>;
}

const MAX_GROUP_TITLE_CODE_POINTS = 80;

function requireBoundedId(name: string, value: string): void {
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} must be a non-empty bounded identifier.`);
  }
}

function requireProviderId(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
}

export function boundGroupTitle(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const bounded = Array.from(normalized).slice(0, MAX_GROUP_TITLE_CODE_POINTS).join("");
  return bounded || "Agent Zero";
}

export function createTaskGroupIntent(input: {
  intentId: string;
  loadGenerationId: LoadGenerationId;
  browserSessionId: string;
  title: string;
  color: AgentGroupColor;
}): TaskGroupIntent {
  requireBoundedId("intentId", input.intentId);
  requireBoundedId("browserSessionId", input.browserSessionId);
  return {
    intentId: input.intentId,
    loadGenerationId: input.loadGenerationId,
    browserSessionId: input.browserSessionId,
    title: boundGroupTitle(input.title),
    color: input.color,
    providerGroupsByWindow: {},
    revision: 0,
  };
}

export function bindProviderGroup(
  intent: TaskGroupIntent,
  providerWindowId: number,
  providerGroupId: number,
): GroupBindingResult {
  requireProviderId("providerWindowId", providerWindowId);
  requireProviderId("providerGroupId", providerGroupId);
  const key = String(providerWindowId);
  const existing = intent.providerGroupsByWindow[key];
  if (existing) {
    if (existing.providerGroupId !== providerGroupId) {
      return { ok: false, code: "GROUP_BINDING_CONFLICT", intent, existing };
    }
    return { ok: true, intent, binding: existing, disposition: "existing" };
  }
  const binding = { providerWindowId, providerGroupId };
  return {
    ok: true,
    disposition: "created",
    binding,
    intent: {
      ...intent,
      providerGroupsByWindow: {
        ...intent.providerGroupsByWindow,
        [key]: binding,
      },
      revision: intent.revision + 1,
    },
  };
}

export function removeProviderGroup(
  intent: TaskGroupIntent,
  providerWindowId: number,
  providerGroupId: number,
): TaskGroupIntent {
  const key = String(providerWindowId);
  const existing = intent.providerGroupsByWindow[key];
  if (!existing || existing.providerGroupId !== providerGroupId) {
    return intent;
  }
  const providerGroupsByWindow = { ...intent.providerGroupsByWindow };
  delete providerGroupsByWindow[key];
  return { ...intent, providerGroupsByWindow, revision: intent.revision + 1 };
}

export function planGroupPlacement(lease: TabLease, intent: TaskGroupIntent): GroupPlacementPlan {
  if (lease.origin === "claimed") {
    return { action: "preserve_user_location", reason: "claimed_tab" };
  }
  if (lease.state !== "active" || lease.userIntervened) {
    return { action: "retain_tab", reason: "lease_not_active" };
  }
  if (lease.loadGenerationId !== intent.loadGenerationId) {
    return { action: "retain_tab", reason: "generation_mismatch" };
  }
  if (lease.browserSessionId !== intent.browserSessionId) {
    return { action: "retain_tab", reason: "browser_session_mismatch" };
  }
  if (lease.groupIntentId !== intent.intentId) {
    return { action: "retain_tab", reason: "intent_mismatch" };
  }
  const providerWindowId = lease.identity.providerWindowId;
  const binding = intent.providerGroupsByWindow[String(providerWindowId)];
  return binding
    ? { action: "join_existing", providerWindowId, providerGroupId: binding.providerGroupId }
    : { action: "create_and_join", providerWindowId, title: intent.title, color: intent.color };
}

export function isExtensionOwnedGroup(
  lease: TabLease,
  intent: TaskGroupIntent,
  providerGroupId: number | null,
): boolean {
  if (
    lease.origin !== "created" ||
    lease.groupIntentId !== intent.intentId ||
    lease.loadGenerationId !== intent.loadGenerationId ||
    lease.browserSessionId !== intent.browserSessionId ||
    providerGroupId === null
  ) {
    return false;
  }
  const binding = intent.providerGroupsByWindow[String(lease.identity.providerWindowId)];
  return binding?.providerGroupId === providerGroupId;
}

export function beginCorrelatedGroupMove(
  lease: TabLease,
  actionId: string,
  target: { providerWindowId: number; providerGroupId: number | "new" },
): TabLease {
  requireBoundedId("actionId", actionId);
  requireProviderId("providerWindowId", target.providerWindowId);
  if (target.providerGroupId !== "new") requireProviderId("providerGroupId", target.providerGroupId);
  if (lease.origin !== "created" || lease.state !== "active" || lease.userIntervened) {
    return lease;
  }
  return {
    ...lease,
    expectedGroupActionId: actionId,
    expectedGroupWindowId: target.providerWindowId,
    expectedProviderGroupId: target.providerGroupId,
    revision: lease.revision + 1,
  };
}

export function observeTabGroupChange(
  lease: TabLease,
  observation: {
    providerWindowId: number;
    providerGroupId: number | null;
    correlatedActionId?: string | null;
  },
): TabLease {
  requireProviderId("providerWindowId", observation.providerWindowId);
  if (observation.providerGroupId !== null) {
    requireProviderId("providerGroupId", observation.providerGroupId);
  }

  const groupTargetMatches =
    lease.expectedProviderGroupId === "new"
      ? observation.providerGroupId !== null
      : lease.expectedProviderGroupId === observation.providerGroupId;
  const correlationMatches =
    lease.expectedGroupActionId !== null &&
    lease.expectedGroupActionId === observation.correlatedActionId &&
    lease.expectedGroupWindowId === observation.providerWindowId &&
    groupTargetMatches;
  if (correlationMatches) {
    return {
      ...lease,
      identity: { ...lease.identity, providerWindowId: observation.providerWindowId },
      providerGroupId: observation.providerGroupId,
      expectedGroupActionId: null,
      expectedGroupWindowId: null,
      expectedProviderGroupId: null,
      revision: lease.revision + 1,
    };
  }

  const windowChanged = lease.identity.providerWindowId !== observation.providerWindowId;
  const groupChanged = lease.providerGroupId !== observation.providerGroupId;
  if (!windowChanged && !groupChanged) {
    return lease;
  }
  return markLeaseUserTakeover(
    lease,
    windowChanged ? "window_changed" : observation.providerGroupId === null ? "ungrouped" : "regrouped",
  );
}

export function createGroupRegistry(): GroupRegistry {
  return { intentsByBrowserSession: {} };
}

export function upsertGroupIntent(registry: GroupRegistry, intent: TaskGroupIntent): GroupRegistry {
  const existing = registry.intentsByBrowserSession[intent.browserSessionId];
  if (existing === intent) {
    return registry;
  }
  return {
    intentsByBrowserSession: {
      ...registry.intentsByBrowserSession,
      [intent.browserSessionId]: intent,
    },
  };
}
