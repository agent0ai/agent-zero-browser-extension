import {
  bindProviderGroup,
  beginCorrelatedGroupMove,
  createTaskGroupIntent,
  observeTabGroupChange,
  planGroupPlacement,
  upsertGroupIntent,
} from "./groups";
import {
  appendChallengeRequiredEvent,
  appendLeaseChangedEvent,
  appendTurnFinalizedEvent,
  type CriticalEventRelay,
} from "./critical-events";
import type { CriticalBrowserEventRecord } from "../protocol/browser-events";
import {
  createDurableLeaseShadow,
  prepareMutation,
  recordCancelControl,
  recordChallengeControl,
  redactUrlIdentity,
  transitionDurableLease,
  transitionMutation,
  upsertDurableLease,
  type CancelControlRecord,
  type DurableMutationStage,
  type MutationJournalRecord,
  type SafeMutationReceipt,
} from "./journal";
import {
  applyFinalizationOutcome,
  createLease,
  markLeaseUserTakeover,
  planLeaseFinalization,
  transferLeaseOnTabReplacement,
  type LeaseDisposition,
  type TabLease,
} from "./leases";
import { createTabHandle, tabHandleBelongsToGeneration } from "./lifecycle";
import { NativeRequestError, browserConnectionAuthorityKey, type NativeConnectionSnapshot } from "./native-port";
import { ContentRuntimeHost } from "./content-host";
import type { InputArtifactBinding, VerifiedInputArtifact } from "./input-artifact";
import {
  ChromeScreenshotDebuggerHost,
  debuggerBindingForLease,
  type DebuggerLeaseBinding,
  type ScreenshotCaptureOptions,
  type ScreenshotDebuggerHost,
} from "./debugger-host";
import {
  assertBeforeDeadline,
  parseBrowserCancelRequest,
  parseBrowserFinalizeRequest,
  parseBrowserPerformRequest,
  type BrowserCancelRequest,
  type BrowserFinalizeRequest,
  type BrowserPerformRequest,
  type ScopedBrowserPerformRequest,
} from "./operations";
import {
  buildBrowserResolveChallengeResult,
  buildActionDataClassification,
  actionDataClassificationsEqual,
  parseBrowserResolveChallengeRequest,
  type BrowserResolveChallengeRequest,
  type ActionBrowserResolveChallengeRequest,
  type ActionChallengeDecision,
  type ActionChallengeGrant,
  type ActionDataClassification,
  type ConsequentialActionClass,
  type SiteBrowserResolveChallengeRequest,
  type SiteChallengeDecision,
  type SiteChallengeGrant,
} from "../protocol/challenges";
import {
  RuntimeStore,
  type PendingActionChallenge,
  type PendingBrowserChallenge,
  type PendingSiteChallenge,
  type RuntimeStoreSnapshot,
  type StoredFinalizationResult,
} from "./runtime-store";
import {
  MAX_OUTPUT_ARTIFACT_BYTES,
  MAX_OUTPUT_ARTIFACT_CHUNK_BYTES,
  type ArtifactAbortReason,
  type ArtifactAck,
  type ArtifactDescriptor,
  type OutputArtifactBinding,
} from "../protocol/artifacts";

export const SITE_CHALLENGE_EXPIRY_ALARM = "a0.browser-bridge.site-challenge-expiry.v1" as const;
const SITE_CHALLENGE_LIFETIME_MS = 120_000;
const MAX_PENDING_SITE_CHALLENGES = 128;

export const BROWSER_RUNTIME_CAPABILITIES = [
  "tab_leases_v1",
  "tab_groups_v1",
  "semantic_dom_v1",
  "cursor_v1",
  "screenshots_v1",
  "artifacts_v1",
  "trusted_input_v1",
] as const;
export const BROWSER_RUNTIME_ACTIONS = [
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

// Every advertised action has an exact cross-layer codec. This subset is not
// a claim that release trust or complete runtime activation is available.
const implementedActions = new Set<string>(BROWSER_RUNTIME_ACTIONS);
const mutatingActions = new Set<string>(["open", "navigate", "scroll", "screenshot", "hover", "click", "type", "upload_file"]);
const supportedCapabilities = new Set<string>([
  ...BROWSER_RUNTIME_CAPABILITIES,
  ...BROWSER_RUNTIME_ACTIONS,
]);
// These are dependencies of the implemented lanes, not caller-selected grants.
const ACTION_FEATURES: Record<string, readonly string[]> = {
  open: ["tab_leases_v1", "tab_groups_v1"],
  list: ["tab_leases_v1"],
  state: ["tab_leases_v1"],
  navigate: ["tab_leases_v1"],
  content: ["tab_leases_v1", "semantic_dom_v1"],
  scroll: ["tab_leases_v1", "semantic_dom_v1"],
  screenshot: ["tab_leases_v1", "screenshots_v1", "artifacts_v1"],
  hover: ["tab_leases_v1", "semantic_dom_v1", "cursor_v1", "trusted_input_v1"],
  click: ["tab_leases_v1", "semantic_dom_v1", "cursor_v1", "trusted_input_v1"],
  type: ["tab_leases_v1", "semantic_dom_v1", "cursor_v1", "trusted_input_v1"],
  upload_file: ["tab_leases_v1", "semantic_dom_v1", "cursor_v1", "trusted_input_v1", "artifacts_v1"],
  status: [],
  ensure: [],
};

function negotiatedActions(actions: readonly string[], features: readonly string[]): string[] {
  return BROWSER_RUNTIME_ACTIONS.filter((action) =>
    actions.includes(action) && ACTION_FEATURES[action].every((feature) => features.includes(feature)),
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function exactHttpUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384) {
    throw new NativeRequestError("A bounded HTTP(S) URL is required.", "INVALID_STATE");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new NativeRequestError("The requested URL is invalid.", "CHROME_RESTRICTED_URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username
    || parsed.password
  ) {
    throw new NativeRequestError("Only credential-free HTTP(S) pages are supported.", "CHROME_RESTRICTED_URL");
  }
  return parsed;
}

function requireOriginGrant(request: ScopedBrowserPerformRequest): void {
  if (!request.policy.originGrantId) {
    throw new NativeRequestError("This page origin has not been authorized by Agent Zero.", "APPROVAL_REQUIRED");
  }
}

function exactActionArgs(
  args: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(args, key))
    || Object.keys(args).some((key) => !allowed.has(key))
  ) {
    throw new NativeRequestError("The browser action arguments are malformed.", "INVALID_STATE");
  }
}

function boundedOptionalInteger(value: unknown, maximum: number, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new NativeRequestError(`The ${name} bound is invalid.`, "INVALID_STATE");
  }
  return Number(value);
}

function operationSuccess(
  request: BrowserPerformRequest,
  result: Record<string, unknown>,
  artifacts: readonly ArtifactDescriptor[] = [],
): Record<string, unknown> {
  return {
    contract_version: request.contractVersion,
    ...(request.opId === null ? {} : { op_id: request.opId }),
    ...(request.actionId === null ? {} : { action_id: request.actionId }),
    status: "succeeded",
    result,
    receipts: [],
    artifacts: [...artifacts],
    completed_at_ms: Date.now(),
  };
}

function leaseForRequest(snapshot: RuntimeStoreSnapshot, request: ScopedBrowserPerformRequest): TabLease {
  const tabHandle = request.target?.tabHandle;
  if (!tabHandle) throw new NativeRequestError("This action requires a leased tab handle.", "LEASE_NOT_FOUND");
  const lease = snapshot.session.leasesByHandle[tabHandle];
  if (!lease) throw new NativeRequestError("The leased tab was not found.", "LEASE_NOT_FOUND");
  if (!tabHandleBelongsToGeneration(lease.tabHandle, snapshot.lifecycle.loadGenerationId)) {
    throw new NativeRequestError("The tab handle belongs to a prior browser generation.", "TAB_IDENTITY_MISMATCH");
  }
  if (lease.contextId !== request.contextId || lease.browserSessionId !== request.browserSessionId) {
    throw new NativeRequestError("The tab lease belongs to a different Agent Zero task.", "LEASE_CONFLICT");
  }
  if (lease.state !== "active") {
    throw new NativeRequestError("The tab lease is no longer active.", "INVALID_STATE");
  }
  return lease;
}

type LiveOperationState = "queued" | "running";

interface OperationAuthority {
  admissionIdentity: string;
  connectionId: string;
  installInstanceId: string;
  loadGenerationId: string;
  workerBootId: string;
  browserInstanceId: string;
}

interface LiveOperation {
  request: ScopedBrowserPerformRequest;
  authority: OperationAuthority;
  state: LiveOperationState;
  cancelRequested: boolean;
  effectInvoked: boolean;
  settled: Promise<void>;
  settle: () => void;
}

interface CancelDecision {
  status: "canceled" | "already_completed" | "not_found" | "outcome_unknown";
  safeReceipt: SafeMutationReceipt | null;
}

interface ChallengeSettlement {
  decision: SiteChallengeDecision | null;
  grant: SiteChallengeGrant | null;
  code: "APPROVAL_DENIED" | "CHALLENGE_EXPIRED" | "CANCELED" | null;
}

interface ChallengeWaiter {
  pending: PendingSiteChallenge;
  settle: (settlement: ChallengeSettlement) => void;
}

interface ActionChallengeSettlement {
  decision: ActionChallengeDecision | null;
  grant: ActionChallengeGrant | null;
  code: "APPROVAL_DENIED" | "CHALLENGE_EXPIRED" | "CANCELED" | null;
}

interface ActionChallengeWaiter {
  pending: PendingActionChallenge;
  settle: (settlement: ActionChallengeSettlement) => void;
}

interface ApprovedNavigation {
  actionId: string;
  leaseId: string;
  tabHandle: string;
  sourceOrigin: string;
  destinationOrigin: string;
  destinationHref: string;
  documentId: string | null;
  documentEpoch: number;
}

export interface ArtifactOutputTransport {
  inputArtifact?(binding: InputArtifactBinding, options: { timeoutMs: number; signal?: AbortSignal }): Promise<VerifiedInputArtifact>;
  artifactBegin(
    binding: OutputArtifactBinding,
    metadata: { mimeType: string; byteCount: number; sha256: string },
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<ArtifactAck>;
  artifactChunk(
    binding: OutputArtifactBinding,
    chunkIndex: number,
    data: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<ArtifactAck>;
  artifactEnd(
    binding: OutputArtifactBinding,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<ArtifactAck>;
  artifactAbort(
    binding: OutputArtifactBinding,
    reasonCode: ArtifactAbortReason,
    options: { timeoutMs: number },
  ): Promise<ArtifactAck>;
}

interface PendingOutputArtifact {
  request: ScopedBrowserPerformRequest;
  binding: OutputArtifactBinding;
  controller: AbortController;
  beginSent: boolean;
  completed: boolean;
  abortSent: boolean;
  failureCode: "CANCELED" | "CONNECTION_LOST" | "DEBUGGER_DETACHED" | "USER_INTERVENED" | null;
}

const unavailableArtifactTransport: ArtifactOutputTransport = {
  artifactBegin: async () => { throw new NativeRequestError("Artifact transport is unavailable.", "UNSUPPORTED_CAPABILITY"); },
  artifactChunk: async () => { throw new NativeRequestError("Artifact transport is unavailable.", "UNSUPPORTED_CAPABILITY"); },
  artifactEnd: async () => { throw new NativeRequestError("Artifact transport is unavailable.", "UNSUPPORTED_CAPABILITY"); },
  artifactAbort: async () => { throw new NativeRequestError("Artifact transport is unavailable.", "UNSUPPORTED_CAPABILITY"); },
};

export class BrowserRuntime {
  private readonly liveOperations = new Map<string, LiveOperation>();
  private readonly operationTails = new Map<string, Promise<void>>();
  private readonly finalizingTurns = new Set<string>();
  private readonly finalizationTails = new Map<string, Promise<void>>();
  private readonly activeFinalizations = new Map<string, {
    canonicalRequestHash: string;
    promise: Promise<StoredFinalizationResult>;
  }>();
  private readonly challengeWaiters = new Map<string, ChallengeWaiter>();
  private readonly actionChallengeWaiters = new Map<string, ActionChallengeWaiter>();
  private readonly approvedNavigations = new Map<number, ApprovedNavigation>();
  private readonly pendingArtifacts = new Map<string, PendingOutputArtifact>();

  constructor(
    private readonly store: RuntimeStore,
    private readonly removeOverlay: (lease: TabLease) => Promise<void> = async () => undefined,
    private readonly contentHost: Pick<ContentRuntimeHost, "bind" | "command" | "release"> = new ContentRuntimeHost(),
    private readonly criticalEvents: Pick<CriticalEventRelay, "publishPersisted"> = { publishPersisted: () => undefined },
    private readonly debuggerHost: ScreenshotDebuggerHost = new ChromeScreenshotDebuggerHost(),
    private readonly artifactTransport: ArtifactOutputTransport = unavailableArtifactTransport,
    private readonly currentConnection: () => NativeConnectionSnapshot = () => ({ state: "disconnected", reasonCode: "authority_unavailable" }),
  ) {}

  async perform(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    let request: BrowserPerformRequest;
    try {
      request = parseBrowserPerformRequest(params);
    } catch (error) {
      throw new NativeRequestError(
        error instanceof Error ? error.message : "The browser operation is malformed.",
        "INVALID_STATE",
      );
    }
    assertBeforeDeadline(request);
    if (!implementedActions.has(request.action)) {
      throw new NativeRequestError("The requested browser action is not implemented by this runtime.", "UNSUPPORTED_CAPABILITY");
    }
    this.currentOperationAuthority(request);

    if (request.action === "status" || request.action === "ensure") {
      return operationSuccess(request, this.status());
    }
    const scopedRequest = request as ScopedBrowserPerformRequest;
    return await this.runScopedOperation(scopedRequest, async () => {
      if (scopedRequest.action === "screenshot") {
        const screenshot = await this.screenshot(scopedRequest);
        return operationSuccess(scopedRequest, screenshot.result, [screenshot.descriptor]);
      }
      return operationSuccess(scopedRequest, await this.executeScopedOperation(scopedRequest));
    });
  }

  private async executeScopedOperation(request: ScopedBrowserPerformRequest): Promise<Record<string, unknown>> {
    switch (request.action) {
      case "open":
        return await this.open(request);
      case "list":
        return this.list(request);
      case "state":
        return await this.state(request);
      case "navigate":
        return await this.navigate(request);
      case "content":
        return await this.content(request);
      case "scroll":
        return await this.scroll(request);
      case "hover":
        return await this.hover(request);
      case "click":
        return await this.click(request);
      case "upload_file":
        return await this.click(request, true);
      case "type":
        return await this.type(request);
      default:
        throw new NativeRequestError("The requested browser action is unavailable.", "UNSUPPORTED_CAPABILITY");
    }
  }

  async cancel(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    let request: BrowserCancelRequest;
    try {
      request = parseBrowserCancelRequest(params);
    } catch (error) {
      throw new NativeRequestError(
        error instanceof Error ? error.message : "The cancellation request is malformed.",
        "INVALID_STATE",
      );
    }

    const requestHash = await sha256(stableJson({
      contract_version: request.contractVersion,
      control_id: request.controlId,
      op_id: request.opId,
      action_id: request.actionId,
      context_id: request.contextId,
      browser_session_id: request.browserSessionId,
      turn_id: request.turnId,
      reason: request.reason,
    }));
    const existingControl = this.store.snapshot.ledger.cancelControls.find(
      (record) => record.controlId === request.controlId,
    );
    if (existingControl?.canonicalRequestHash !== undefined) {
      if (existingControl.canonicalRequestHash !== requestHash) {
        throw new NativeRequestError("The cancellation control identity was reused with different parameters.", "IDEMPOTENCY_CONFLICT");
      }
      return this.cancelResult(request, existingControl);
    }

    const live = this.exactLiveOperation(request);
    if (live) live.cancelRequested = true;
    const leaseHandleDigest = live?.request.target?.tabHandle
      ? await sha256(live.request.target.tabHandle)
      : null;
    let decision: CancelDecision = { status: "not_found", safeReceipt: null };
    const storedControl: { record: CancelControlRecord | null } = { record: null };
    await this.store.updateLedger((ledger) => {
      const operation = ledger.operations.find((record) => this.operationMatchesCancel(record, request));
      const currentLive = this.exactLiveOperation(request);
      let nextLedger = ledger;

      if (operation && ["succeeded", "failed", "canceled", "outcome_unknown"].includes(operation.stage)) {
        decision = { status: "already_completed", safeReceipt: operation.safeReceipt };
      } else if (currentLive && currentLive.effectInvoked) {
        decision = {
          status: "outcome_unknown",
          safeReceipt: { outcome: "unknown", code: "OUTCOME_UNKNOWN", leaseHandleDigest },
        };
      } else if (currentLive) {
        decision = {
          status: "canceled",
          safeReceipt: { outcome: "not_applied", code: "CANCELED", leaseHandleDigest },
        };
        if (operation) {
          const transitioned = transitionMutation(nextLedger, {
            expectedRevision: nextLedger.revision,
            loadGenerationId: operation.loadGenerationId,
            actionId: operation.actionId,
            expectedStage: operation.stage,
            stage: "canceled",
            safeReceipt: decision.safeReceipt,
            now: Date.now(),
          });
          if (!transitioned.ok) {
            throw new NativeRequestError("The cancellation could not advance the mutation journal.", "STORAGE_WRITE_FAILED");
          }
          nextLedger = transitioned.ledger;
        }
      } else if (operation) {
        decision = {
          status: "outcome_unknown",
          safeReceipt: {
            outcome: "unknown",
            code: "OUTCOME_UNKNOWN",
            leaseHandleDigest: operation.safeReceipt?.leaseHandleDigest ?? null,
          },
        };
        const transitioned = transitionMutation(nextLedger, {
          expectedRevision: nextLedger.revision,
          loadGenerationId: operation.loadGenerationId,
          actionId: operation.actionId,
          expectedStage: operation.stage,
          stage: "outcome_unknown",
          safeReceipt: decision.safeReceipt,
          now: Date.now(),
        });
        if (!transitioned.ok) {
          throw new NativeRequestError("The abandoned mutation outcome could not be journaled.", "STORAGE_WRITE_FAILED");
        }
        nextLedger = transitioned.ledger;
      }

      const stored = recordCancelControl(nextLedger, {
        expectedRevision: nextLedger.revision,
        controlId: request.controlId,
        canonicalRequestHash: requestHash,
        status: decision.status,
        safeReceipt: decision.safeReceipt,
        now: Date.now(),
      });
      if (!stored.ok) {
        throw new NativeRequestError(
          "The cancellation result could not be journaled.",
          stored.code === "IDEMPOTENCY_CONFLICT" ? "IDEMPOTENCY_CONFLICT" : "STORAGE_WRITE_FAILED",
        );
      }
      storedControl.record = stored.value.record;
      return stored.ledger;
    });

    if (!storedControl.record) {
      throw new NativeRequestError("The cancellation result was not journaled.", "STORAGE_WRITE_FAILED");
    }
    const result = this.cancelResult(request, storedControl.record);
    if (live && (decision.status === "canceled" || decision.status === "outcome_unknown")) {
      await this.cancelPendingChallengeForOperation(live.request, "CANCELED");
      await this.cancelPendingArtifactForOperation(live.request, "CANCELED");
      await this.cancelOperationCursor(live, request.controlId);
    }
    return result;
  }

  async resolveChallenge(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    let request: BrowserResolveChallengeRequest;
    try {
      request = parseBrowserResolveChallengeRequest(params);
    } catch (error) {
      throw new NativeRequestError(
        error instanceof Error ? error.message : "The site challenge resolution is malformed.",
        "INVALID_STATE",
      );
    }
    if (request.actionClass !== "navigate") {
      return await this.resolveActionChallenge(request);
    }
    const requestHash = await sha256(stableJson({
      contract_version: request.contractVersion,
      control_id: request.controlId,
      challenge_id: request.challengeId,
      context_id: request.contextId,
      browser_session_id: request.browserSessionId,
      turn_id: request.turnId,
      op_id: request.opId,
      action_id: request.actionId,
      tab_handle: request.tabHandle,
      document_id: request.documentId,
      document_epoch: request.documentEpoch,
      canonical_parameter_hash: request.canonicalParameterHash,
      target_fingerprint: request.targetFingerprint,
      origin: request.origin,
      action_class: request.actionClass,
      decision: request.decision,
      grant: request.grant === null ? null : {
        origin_grant_id: request.grant.originGrantId,
        scope: request.grant.scope,
        origin: request.grant.origin,
        expires_at_ms: request.grant.expiresAtMs,
      },
    }));
    const currentGeneration = this.store.snapshot.lifecycle.loadGenerationId;
    const existing = this.store.snapshot.ledger.challengeControls.find(
      (record) => record.controlId === request.controlId,
    );
    if (existing) {
      if (
        existing.loadGenerationId !== currentGeneration
        || existing.challengeId !== request.challengeId
        || existing.canonicalRequestHash !== requestHash
      ) throw new NativeRequestError("The challenge control identity was reused with different parameters.", "IDEMPOTENCY_CONFLICT");
      return buildBrowserResolveChallengeResult({
        controlId: existing.controlId,
        challengeId: existing.challengeId,
        decision: existing.decision,
      });
    }
    if (this.store.snapshot.ledger.challengeControls.some((record) =>
      record.loadGenerationId === currentGeneration && record.challengeId === request.challengeId,
    )) throw new NativeRequestError("The site challenge was already resolved by a different control.", "IDEMPOTENCY_CONFLICT");

    const pending = this.store.snapshot.session.pendingChallenges.find(
      (challenge): challenge is PendingSiteChallenge =>
        challenge.challengeId === request.challengeId && !this.isPendingActionChallenge(challenge),
    );
    if (!pending) throw new NativeRequestError("The site challenge is unknown or no longer pending.", "APPROVAL_DENIED");
    try {
      this.assertChallengeBinding(request, pending);
    } catch (error) {
      await this.cancelPendingChallenges(
        (challenge) => challenge.challengeId === pending.challengeId,
        "APPROVAL_DENIED",
      );
      throw error;
    }
    const now = Date.now();
    if (now >= pending.expiresAtMs) {
      await this.expireChallenges(now);
      throw new NativeRequestError("The site challenge expired before resolution.", "CHALLENGE_EXPIRED");
    }
    if (request.decision !== "deny") {
      try {
        if (
          !request.grant
          || request.grant.origin !== pending.destinationOrigin
          || request.grant.expiresAtMs <= now
          || request.grant.expiresAtMs > pending.expiresAtMs
          || !this.challengeWaiters.has(pending.challengeId)
        ) throw new NativeRequestError("The server site grant does not match the pending challenge.", "APPROVAL_DENIED");
        const lease = this.exactPendingChallengeLease(pending);
        await this.exactLeasedTab(lease);
        this.assertPendingChallengeCurrent(pending);
      } catch {
        await this.cancelPendingChallenges(
          (challenge) => challenge.challengeId === pending.challengeId,
          "APPROVAL_DENIED",
        );
        throw new NativeRequestError("The server site grant or tab binding was not current.", "APPROVAL_DENIED");
      }
    }

    await this.store.updateBoth((snapshot) => {
      const replay = snapshot.ledger.challengeControls.find((record) => record.controlId === request.controlId);
      if (replay) {
        if (
          replay.loadGenerationId !== snapshot.lifecycle.loadGenerationId
          || replay.challengeId !== request.challengeId
          || replay.canonicalRequestHash !== requestHash
        ) throw new NativeRequestError("The challenge control identity was reused with different parameters.", "IDEMPOTENCY_CONFLICT");
        return snapshot;
      }
      if (snapshot.ledger.challengeControls.some((record) =>
        record.loadGenerationId === snapshot.lifecycle.loadGenerationId
        && record.challengeId === request.challengeId,
      )) throw new NativeRequestError("The site challenge was already resolved by a different control.", "IDEMPOTENCY_CONFLICT");
      const current = snapshot.session.pendingChallenges.find(
        (challenge): challenge is PendingSiteChallenge =>
          challenge.challengeId === request.challengeId && !this.isPendingActionChallenge(challenge),
      );
      this.assertChallengeBinding(request, current);
      if (Date.now() >= current.expiresAtMs) {
        throw new NativeRequestError("The site challenge expired before resolution.", "CHALLENGE_EXPIRED");
      }
      const operation = snapshot.ledger.operations.find((record) =>
        record.loadGenerationId === snapshot.lifecycle.loadGenerationId
        && record.actionId === current.actionId
        && record.opId === current.opId
        && record.contextId === current.contextId
        && record.browserSessionId === current.browserSessionId
        && record.turnId === current.turnId,
      );
      if (!operation || operation.stage !== "waiting_approval") {
        throw new NativeRequestError("The challenged operation is no longer waiting for approval.", "CANCELED");
      }
      let ledger = snapshot.ledger;
      if (request.decision === "deny") {
        const canceled = transitionMutation(ledger, {
          expectedRevision: ledger.revision,
          loadGenerationId: snapshot.lifecycle.loadGenerationId,
          actionId: current.actionId,
          expectedStage: "waiting_approval",
          stage: "canceled",
          safeReceipt: { outcome: "not_applied", code: "APPROVAL_DENIED", leaseHandleDigest: null },
          now: Date.now(),
        });
        if (!canceled.ok) throw new NativeRequestError("The denied operation could not be canceled durably.", "STORAGE_WRITE_FAILED");
        ledger = canceled.ledger;
      }
      const recorded = recordChallengeControl(ledger, {
        expectedRevision: ledger.revision,
        loadGenerationId: snapshot.lifecycle.loadGenerationId,
        controlId: request.controlId,
        challengeId: request.challengeId,
        canonicalRequestHash: requestHash,
        decision: request.decision,
        now: Date.now(),
      });
      if (!recorded.ok) {
        throw new NativeRequestError(
          "The challenge resolution could not be journaled.",
          recorded.code === "IDEMPOTENCY_CONFLICT" ? "IDEMPOTENCY_CONFLICT" : "STORAGE_WRITE_FAILED",
        );
      }
      return {
        ...snapshot,
        ledger: recorded.ledger,
        session: {
          ...snapshot.session,
          pendingChallenges: snapshot.session.pendingChallenges.filter(
            (challenge) => challenge.challengeId !== request.challengeId,
          ),
        },
      };
    });
    await this.rescheduleChallengeExpiry();
    const waiter = this.challengeWaiters.get(request.challengeId);
    waiter?.settle({
      decision: request.decision,
      grant: request.grant,
      code: request.decision === "deny" ? "APPROVAL_DENIED" : null,
    });
    const stored = this.store.snapshot.ledger.challengeControls.find(
      (record) => record.controlId === request.controlId && record.canonicalRequestHash === requestHash,
    );
    if (!stored) throw new NativeRequestError("The challenge resolution was not journaled.", "STORAGE_WRITE_FAILED");
    return buildBrowserResolveChallengeResult({
      controlId: stored.controlId,
      challengeId: stored.challengeId,
      decision: stored.decision,
    });
  }

  private async resolveActionChallenge(
    request: ActionBrowserResolveChallengeRequest,
  ): Promise<Record<string, unknown>> {
    const requestHash = await sha256(stableJson({
      contract_version: request.contractVersion,
      control_id: request.controlId,
      challenge_id: request.challengeId,
      context_id: request.contextId,
      browser_session_id: request.browserSessionId,
      turn_id: request.turnId,
      op_id: request.opId,
      action_id: request.actionId,
      tab_handle: request.tabHandle,
      document_id: request.documentId,
      document_epoch: request.documentEpoch,
      canonical_parameter_hash: request.canonicalParameterHash,
      target_fingerprint: request.targetFingerprint,
      origin: request.origin,
      action_class: request.actionClass,
      data_classification: buildActionDataClassification(request.dataClassification),
      decision: request.decision,
      grant: request.grant === null ? null : {
        action_grant_id: request.grant.actionGrantId,
        scope: request.grant.scope,
        origin: request.grant.origin,
        action_class: request.grant.actionClass,
        canonical_parameter_hash: request.grant.canonicalParameterHash,
        target_fingerprint: request.grant.targetFingerprint,
        data_classification: buildActionDataClassification(request.grant.dataClassification),
        expires_at_ms: request.grant.expiresAtMs,
      },
    }));
    const currentGeneration = this.store.snapshot.lifecycle.loadGenerationId;
    const existing = this.store.snapshot.ledger.challengeControls.find(
      (record) => record.controlId === request.controlId,
    );
    if (existing) {
      if (
        existing.loadGenerationId !== currentGeneration
        || existing.challengeId !== request.challengeId
        || existing.canonicalRequestHash !== requestHash
      ) throw new NativeRequestError("The action challenge control identity was reused with different parameters.", "IDEMPOTENCY_CONFLICT");
      return buildBrowserResolveChallengeResult({
        controlId: existing.controlId,
        challengeId: existing.challengeId,
        decision: existing.decision,
      });
    }
    if (this.store.snapshot.ledger.challengeControls.some((record) =>
      record.loadGenerationId === currentGeneration && record.challengeId === request.challengeId,
    )) throw new NativeRequestError("The action challenge was already resolved by a different control.", "IDEMPOTENCY_CONFLICT");

    const pending = this.store.snapshot.session.pendingChallenges.find(
      (challenge): challenge is PendingActionChallenge =>
        challenge.challengeId === request.challengeId && this.isPendingActionChallenge(challenge),
    );
    if (!pending) throw new NativeRequestError("The action challenge is unknown or no longer pending.", "APPROVAL_DENIED");
    try {
      this.assertActionChallengeBinding(request, pending);
    } catch (error) {
      await this.cancelPendingChallenges((challenge) => challenge.challengeId === pending.challengeId, "APPROVAL_DENIED");
      throw error;
    }
    const now = Date.now();
    if (now >= pending.expiresAtMs) {
      await this.expireChallenges(now);
      throw new NativeRequestError("The action challenge expired before resolution.", "CHALLENGE_EXPIRED");
    }
    if (request.decision === "approve_once") {
      try {
        const grant = request.grant;
        if (
          !grant
          || grant.scope !== "operation"
          || grant.origin !== pending.sourceOrigin
          || grant.actionClass !== pending.actionClass
          || grant.canonicalParameterHash !== pending.canonicalParameterHash
          || grant.targetFingerprint !== pending.targetFingerprint
          || !actionDataClassificationsEqual(grant.dataClassification, pending.dataClassification)
          || grant.expiresAtMs <= now
          || grant.expiresAtMs > pending.expiresAtMs
          || !this.actionChallengeWaiters.has(pending.challengeId)
        ) throw new NativeRequestError("The server action grant does not match the pending challenge.", "APPROVAL_DENIED");
        const lease = this.exactPendingChallengeLease(pending);
        await this.exactLeasedTab(lease);
        this.assertPendingChallengeCurrent(pending);
      } catch {
        await this.cancelPendingChallenges((challenge) => challenge.challengeId === pending.challengeId, "APPROVAL_DENIED");
        throw new NativeRequestError("The server action grant or tab binding was not current.", "APPROVAL_DENIED");
      }
    }

    await this.store.updateBoth((snapshot) => {
      const replay = snapshot.ledger.challengeControls.find((record) => record.controlId === request.controlId);
      if (replay) {
        if (
          replay.loadGenerationId !== snapshot.lifecycle.loadGenerationId
          || replay.challengeId !== request.challengeId
          || replay.canonicalRequestHash !== requestHash
        ) throw new NativeRequestError("The action challenge control identity was reused with different parameters.", "IDEMPOTENCY_CONFLICT");
        return snapshot;
      }
      if (snapshot.ledger.challengeControls.some((record) =>
        record.loadGenerationId === snapshot.lifecycle.loadGenerationId
        && record.challengeId === request.challengeId,
      )) throw new NativeRequestError("The action challenge was already resolved by a different control.", "IDEMPOTENCY_CONFLICT");
      const current = snapshot.session.pendingChallenges.find(
        (challenge): challenge is PendingActionChallenge =>
          challenge.challengeId === request.challengeId && this.isPendingActionChallenge(challenge),
      );
      this.assertActionChallengeBinding(request, current);
      if (Date.now() >= current.expiresAtMs) {
        throw new NativeRequestError("The action challenge expired before resolution.", "CHALLENGE_EXPIRED");
      }
      const operation = snapshot.ledger.operations.find((record) =>
        record.loadGenerationId === snapshot.lifecycle.loadGenerationId
        && record.actionId === current.actionId
        && record.opId === current.opId
        && record.contextId === current.contextId
        && record.browserSessionId === current.browserSessionId
        && record.turnId === current.turnId,
      );
      if (!operation || operation.stage !== "waiting_approval") {
        throw new NativeRequestError("The action is no longer waiting for approval.", "CANCELED");
      }
      let ledger = snapshot.ledger;
      if (request.decision === "decline") {
        const canceled = transitionMutation(ledger, {
          expectedRevision: ledger.revision,
          loadGenerationId: snapshot.lifecycle.loadGenerationId,
          actionId: current.actionId,
          expectedStage: "waiting_approval",
          stage: "canceled",
          safeReceipt: { outcome: "not_applied", code: "APPROVAL_DENIED", leaseHandleDigest: null },
          now: Date.now(),
        });
        if (!canceled.ok) throw new NativeRequestError("The declined action could not be canceled durably.", "STORAGE_WRITE_FAILED");
        ledger = canceled.ledger;
      }
      const recorded = recordChallengeControl(ledger, {
        expectedRevision: ledger.revision,
        loadGenerationId: snapshot.lifecycle.loadGenerationId,
        controlId: request.controlId,
        challengeId: request.challengeId,
        canonicalRequestHash: requestHash,
        decision: request.decision,
        now: Date.now(),
      });
      if (!recorded.ok) {
        throw new NativeRequestError(
          "The action challenge resolution could not be journaled.",
          recorded.code === "IDEMPOTENCY_CONFLICT" ? "IDEMPOTENCY_CONFLICT" : "STORAGE_WRITE_FAILED",
        );
      }
      return {
        ...snapshot,
        ledger: recorded.ledger,
        session: {
          ...snapshot.session,
          pendingChallenges: snapshot.session.pendingChallenges.filter(
            (challenge) => challenge.challengeId !== request.challengeId,
          ),
        },
      };
    });
    await this.rescheduleChallengeExpiry();
    this.actionChallengeWaiters.get(request.challengeId)?.settle({
      decision: request.decision,
      grant: request.grant,
      code: request.decision === "decline" ? "APPROVAL_DENIED" : null,
    });
    const stored = this.store.snapshot.ledger.challengeControls.find(
      (record) => record.controlId === request.controlId && record.canonicalRequestHash === requestHash,
    );
    if (!stored) throw new NativeRequestError("The action challenge resolution was not journaled.", "STORAGE_WRITE_FAILED");
    return buildBrowserResolveChallengeResult({
      controlId: stored.controlId,
      challengeId: stored.challengeId,
      decision: stored.decision,
    });
  }

  async recoverPendingChallenges(): Promise<void> {
    await this.cancelPendingChallenges(() => true, "CANCELED");
  }

  async disconnectPendingChallenges(): Promise<void> {
    await this.cancelPendingChallenges(() => true, "CANCELED");
  }

  async disconnectPendingArtifacts(): Promise<void> {
    const pending = [...this.pendingArtifacts.values()];
    for (const artifact of pending) {
      // At disconnect there may be no usable transport left. Retain only the
      // bounded binding/cleanup debt in memory and never persist captured data.
      await this.abortPendingArtifact(artifact, "CONNECTION_LOST", "CONNECTION_LOST");
    }
  }

  async expireChallenges(now = Date.now()): Promise<void> {
    await this.cancelPendingChallenges((challenge) => challenge.expiresAtMs <= now, "CHALLENGE_EXPIRED");
  }

  private async runScopedOperation<T>(
    request: ScopedBrowserPerformRequest,
    task: () => Promise<T>,
  ): Promise<T> {
    this.assertTurnAcceptsOperations(request);
    if (this.liveOperations.has(request.actionId)) {
      throw new NativeRequestError("The action already has a live browser operation.", "IDEMPOTENCY_CONFLICT");
    }
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const live: LiveOperation = {
      request,
      authority: this.currentOperationAuthority(request),
      state: "queued",
      cancelRequested: false,
      effectInvoked: false,
      settled,
      settle,
    };
    this.liveOperations.set(request.actionId, live);
    const queueKey = request.target?.tabHandle || `operation:${request.actionId}`;
    const prior = this.operationTails.get(queueKey) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.catch(() => undefined).then(async () => await gate);
    this.operationTails.set(queueKey, tail);

    try {
      await prior.catch(() => undefined);
      this.assertTurnAcceptsOperations(request);
      this.assertNotCanceled(request);
      live.state = "running";
      const value = await task();
      this.assertCapturedAuthority(request);
      if (!mutatingActions.has(request.action)) this.assertNotCanceled(request);
      return value;
    } finally {
      release();
      if (this.operationTails.get(queueKey) === tail) this.operationTails.delete(queueKey);
      if (this.liveOperations.get(request.actionId) === live) this.liveOperations.delete(request.actionId);
      settle();
    }
  }

  private turnKey(value: Pick<ScopedBrowserPerformRequest | BrowserFinalizeRequest, "contextId" | "browserSessionId" | "turnId">): string {
    return `${value.contextId}\u0000${value.browserSessionId}\u0000${value.turnId}`;
  }

  private assertTurnAcceptsOperations(request: ScopedBrowserPerformRequest): void {
    const key = this.turnKey(request);
    if (
      this.finalizingTurns.has(key)
      || this.store.snapshot.session.finalizedTurns.some((barrier) =>
        barrier.contextId === request.contextId
        && barrier.browserSessionId === request.browserSessionId
        && barrier.turnId === request.turnId,
      )
    ) {
      throw new NativeRequestError("The Agent Zero turn is already finalizing.", "CANCELED");
    }
  }

  private exactLiveOperation(request: BrowserCancelRequest): LiveOperation | null {
    const live = this.liveOperations.get(request.actionId);
    return live
      && live.request.opId === request.opId
      && live.request.contextId === request.contextId
      && live.request.browserSessionId === request.browserSessionId
      && live.request.turnId === request.turnId
      ? live
      : null;
  }

  private operationMatchesCancel(record: MutationJournalRecord, request: BrowserCancelRequest): boolean {
    return record.actionId === request.actionId
      && record.opId === request.opId
      && record.contextId === request.contextId
      && record.browserSessionId === request.browserSessionId
      && record.turnId === request.turnId;
  }

  private cancelResult(request: BrowserCancelRequest, record: CancelControlRecord): Record<string, unknown> {
    return {
      contract_version: request.contractVersion,
      control_id: request.controlId,
      op_id: request.opId,
      action_id: request.actionId,
      status: record.status,
      ...(record.safeReceipt === null ? {} : {
        receipt: {
          outcome: record.safeReceipt.outcome,
          code: record.safeReceipt.code,
        },
      }),
    };
  }

  private assertChallengeBinding(
    request: SiteBrowserResolveChallengeRequest,
    pending: PendingSiteChallenge | undefined,
  ): asserts pending is PendingSiteChallenge {
    if (
      !pending
      || pending.loadGenerationId !== this.store.snapshot.lifecycle.loadGenerationId
      || pending.contextId !== request.contextId
      || pending.browserSessionId !== request.browserSessionId
      || pending.turnId !== request.turnId
      || pending.opId !== request.opId
      || pending.actionId !== request.actionId
      || pending.tabHandle !== request.tabHandle
      || pending.documentId !== request.documentId
      || pending.documentEpoch !== request.documentEpoch
      || pending.canonicalParameterHash !== request.canonicalParameterHash
      || pending.targetFingerprint !== request.targetFingerprint
      || pending.destinationOrigin !== request.origin
      || request.actionClass !== "navigate"
    ) throw new NativeRequestError("The site challenge resolution binding did not match.", "APPROVAL_DENIED");
  }

  private isPendingActionChallenge(challenge: PendingBrowserChallenge): challenge is PendingActionChallenge {
    return "actionClass" in challenge;
  }

  private assertActionChallengeBinding(
    request: ActionBrowserResolveChallengeRequest,
    pending: PendingActionChallenge | undefined,
  ): asserts pending is PendingActionChallenge {
    if (
      !pending
      || pending.loadGenerationId !== this.store.snapshot.lifecycle.loadGenerationId
      || pending.contextId !== request.contextId
      || pending.browserSessionId !== request.browserSessionId
      || pending.turnId !== request.turnId
      || pending.opId !== request.opId
      || pending.actionId !== request.actionId
      || pending.tabHandle !== request.tabHandle
      || pending.documentId !== request.documentId
      || pending.documentEpoch !== request.documentEpoch
      || pending.canonicalParameterHash !== request.canonicalParameterHash
      || pending.targetFingerprint !== request.targetFingerprint
      || pending.sourceOrigin !== request.origin
      || pending.actionClass !== request.actionClass
      || !actionDataClassificationsEqual(pending.dataClassification, request.dataClassification)
    ) throw new NativeRequestError("The action challenge resolution binding did not match.", "APPROVAL_DENIED");
  }

  private exactPendingChallengeLease(pending: PendingBrowserChallenge): TabLease {
    const lease = this.store.snapshot.session.leasesByHandle[pending.tabHandle];
    if (
      !lease
      || lease.loadGenerationId !== pending.loadGenerationId
      || lease.leaseId !== pending.leaseId
      || lease.contextId !== pending.contextId
      || lease.browserSessionId !== pending.browserSessionId
      || lease.turnId !== pending.turnId
      || lease.identity.documentId !== pending.documentId
      || lease.identity.documentEpoch !== pending.documentEpoch
      || lease.siteOrigin !== pending.sourceOrigin
      || lease.state !== "active"
    ) throw new NativeRequestError("The challenged tab binding is no longer current.", "APPROVAL_DENIED");
    return lease;
  }

  private assertPendingChallengeCurrent(pending: PendingBrowserChallenge): void {
    const current = this.store.snapshot.session.pendingChallenges.find(
      (challenge) => challenge.challengeId === pending.challengeId,
    );
    if (
      !current
      || current.targetFingerprint !== pending.targetFingerprint
      || this.isPendingActionChallenge(current) !== this.isPendingActionChallenge(pending)
    ) {
      throw new NativeRequestError("The site challenge is no longer pending.", "CANCELED");
    }
  }

  private assertChallengeTransportAuthority(request: ScopedBrowserPerformRequest): void {
    this.assertOperationAuthority(request);
  }

  private async awaitSiteChallenge(
    request: ScopedBrowserPerformRequest,
    lease: TabLease,
    destination: URL,
    canonicalParameterHash: string,
  ): Promise<ChallengeSettlement> {
    this.assertNotCanceled(request);
    const now = Date.now();
    const expiresAtMs = Math.min(request.deadlineAtMs, now + SITE_CHALLENGE_LIFETIME_MS);
    if (expiresAtMs <= now) {
      await this.transitionMutationRecord(request.actionId, "prepared", "failed", {
        outcome: "not_applied",
        code: "CHALLENGE_EXPIRED",
        leaseHandleDigest: await sha256(lease.tabHandle),
      });
      return { decision: null, grant: null, code: "CHALLENGE_EXPIRED" };
    }
    const leaseIdDigest = await sha256(lease.leaseId);
    const browserIdDigest = await sha256(lease.tabHandle);
    const targetFingerprint = await sha256(stableJson({
      action_class: "navigate",
      browser_id_digest: browserIdDigest,
      document_epoch: lease.identity.documentEpoch,
      document_id: lease.identity.documentId,
      lease_id_digest: leaseIdDigest,
      load_generation_id: lease.loadGenerationId,
      origin: destination.origin,
    }));
    const pending: PendingSiteChallenge = {
      challengeId: `a0ch1.${crypto.randomUUID()}`,
      loadGenerationId: lease.loadGenerationId,
      leaseId: lease.leaseId,
      tabHandle: lease.tabHandle,
      contextId: request.contextId,
      browserSessionId: request.browserSessionId,
      turnId: request.turnId,
      opId: request.opId,
      actionId: request.actionId,
      sourceOrigin: lease.siteOrigin,
      destinationOrigin: destination.origin,
      documentId: lease.identity.documentId,
      documentEpoch: lease.identity.documentEpoch,
      canonicalParameterHash,
      targetFingerprint,
      expiresAtMs,
    };
    let resolveSettlement!: (value: ChallengeSettlement) => void;
    const settlement = new Promise<ChallengeSettlement>((resolve) => { resolveSettlement = resolve; });
    const waiter: ChallengeWaiter = { pending, settle: resolveSettlement };
    this.challengeWaiters.set(pending.challengeId, waiter);
    let persistedEvent: CriticalBrowserEventRecord | null = null;
    try {
      await this.store.updateBoth((snapshot) => {
        this.assertNotCanceled(request);
        const currentLease = this.exactPendingChallengeLease(pending);
        if (currentLease.revision !== lease.revision) {
          throw new NativeRequestError("The challenged tab changed before the challenge was journaled.", "APPROVAL_DENIED");
        }
        if (
          snapshot.session.pendingChallenges.length >= MAX_PENDING_SITE_CHALLENGES
          || snapshot.session.pendingChallenges.some((challenge) =>
            challenge.challengeId === pending.challengeId || challenge.actionId === pending.actionId,
          )
        ) throw new NativeRequestError("The pending site challenge store is full or conflicted.", "INVALID_STATE");
        const waiting = transitionMutation(snapshot.ledger, {
          expectedRevision: snapshot.ledger.revision,
          loadGenerationId: snapshot.lifecycle.loadGenerationId,
          actionId: request.actionId,
          expectedStage: "prepared",
          stage: "waiting_approval",
          safeReceipt: null,
          now,
        });
        if (!waiting.ok) throw new NativeRequestError("The challenge wait could not be journaled.", "STORAGE_WRITE_FAILED");
        const appended = appendChallengeRequiredEvent(waiting.ledger, {
          loadGenerationId: snapshot.lifecycle.loadGenerationId,
          contextId: request.contextId,
          browserSessionId: request.browserSessionId,
          turnId: request.turnId,
          opId: request.opId,
          actionId: request.actionId,
          data: {
            challengeId: pending.challengeId,
            kind: "site",
            origin: destination.origin,
            actionClass: "navigate",
            canonicalParameterHash,
            targetFingerprint,
            leaseIdDigest,
            browserIdDigest,
            documentId: lease.identity.documentId,
            documentEpoch: lease.identity.documentEpoch,
            summary: `Allow Agent Zero to work on ${destination.hostname}?`,
            options: ["deny", "allow_once", "allow_turn"],
            expiresAtMs,
          },
          now,
        });
        if (!appended.ok || !appended.event) {
          throw new NativeRequestError("The site challenge event could not be journaled.", "STORAGE_WRITE_FAILED");
        }
        persistedEvent = appended.event;
        return {
          ...snapshot,
          ledger: appended.ledger,
          session: {
            ...snapshot.session,
            pendingChallenges: [...snapshot.session.pendingChallenges, pending],
          },
        };
      });
      await this.rescheduleChallengeExpiry();
      if (persistedEvent) this.criticalEvents.publishPersisted(persistedEvent);
      return await settlement;
    } catch (error) {
      if (this.challengeWaiters.get(pending.challengeId) === waiter) {
        this.challengeWaiters.delete(pending.challengeId);
      }
      throw error;
    } finally {
      if (this.challengeWaiters.get(pending.challengeId) === waiter) {
        this.challengeWaiters.delete(pending.challengeId);
      }
    }
  }

  private async awaitActionChallenge(
    request: ScopedBrowserPerformRequest,
    lease: TabLease,
    actionClass: ConsequentialActionClass,
    targetFingerprint: string,
    canonicalParameterHash: string,
    dataClassification: ActionDataClassification = "none",
    summary = "Allow Agent Zero to click the highlighted control?",
  ): Promise<ActionChallengeSettlement> {
    this.assertNotCanceled(request);
    const now = Date.now();
    const expiresAtMs = Math.min(request.deadlineAtMs, now + SITE_CHALLENGE_LIFETIME_MS);
    if (expiresAtMs <= now) {
      await this.transitionMutationRecord(request.actionId, "prepared", "failed", {
        outcome: "not_applied",
        code: "CHALLENGE_EXPIRED",
        leaseHandleDigest: await sha256(lease.tabHandle),
      });
      return { decision: null, grant: null, code: "CHALLENGE_EXPIRED" };
    }
    if (!lease.identity.documentId) {
      throw new NativeRequestError("Action approval requires an exact bound document.", "DOCUMENT_MISMATCH");
    }
    const leaseIdDigest = await sha256(lease.leaseId);
    const browserIdDigest = await sha256(lease.tabHandle);
    const pending: PendingActionChallenge = {
      challengeId: `a0ch1.${crypto.randomUUID()}`,
      loadGenerationId: lease.loadGenerationId,
      leaseId: lease.leaseId,
      tabHandle: lease.tabHandle,
      contextId: request.contextId,
      browserSessionId: request.browserSessionId,
      turnId: request.turnId,
      opId: request.opId,
      actionId: request.actionId,
      sourceOrigin: lease.siteOrigin,
      documentId: lease.identity.documentId,
      documentEpoch: lease.identity.documentEpoch,
      canonicalParameterHash,
      targetFingerprint,
      actionClass,
      dataClassification,
      expiresAtMs,
    };
    let resolveSettlement!: (value: ActionChallengeSettlement) => void;
    const settlement = new Promise<ActionChallengeSettlement>((resolve) => { resolveSettlement = resolve; });
    const waiter: ActionChallengeWaiter = { pending, settle: resolveSettlement };
    this.actionChallengeWaiters.set(pending.challengeId, waiter);
    let persistedEvent: CriticalBrowserEventRecord | null = null;
    try {
      await this.store.updateBoth((snapshot) => {
        this.assertNotCanceled(request);
        const currentLease = this.exactPendingChallengeLease(pending);
        if (currentLease.revision !== lease.revision) {
          throw new NativeRequestError("The action target changed before approval was journaled.", "APPROVAL_DENIED");
        }
        if (
          snapshot.session.pendingChallenges.length >= MAX_PENDING_SITE_CHALLENGES
          || snapshot.session.pendingChallenges.some((challenge) =>
            challenge.challengeId === pending.challengeId || challenge.actionId === pending.actionId,
          )
        ) throw new NativeRequestError("The pending action challenge store is full or conflicted.", "INVALID_STATE");
        const waiting = transitionMutation(snapshot.ledger, {
          expectedRevision: snapshot.ledger.revision,
          loadGenerationId: snapshot.lifecycle.loadGenerationId,
          actionId: request.actionId,
          expectedStage: "prepared",
          stage: "waiting_approval",
          safeReceipt: null,
          now,
        });
        if (!waiting.ok) throw new NativeRequestError("The action challenge wait could not be journaled.", "STORAGE_WRITE_FAILED");
        const appended = appendChallengeRequiredEvent(waiting.ledger, {
          loadGenerationId: snapshot.lifecycle.loadGenerationId,
          contextId: request.contextId,
          browserSessionId: request.browserSessionId,
          turnId: request.turnId,
          opId: request.opId,
          actionId: request.actionId,
          data: {
            challengeId: pending.challengeId,
            kind: "action",
            origin: pending.sourceOrigin,
            actionClass,
            canonicalParameterHash,
            targetFingerprint,
            leaseIdDigest,
            browserIdDigest,
            documentId: pending.documentId,
            documentEpoch: pending.documentEpoch,
            summary,
            options: ["decline", "approve_once"],
            dataClassification,
            expiresAtMs,
          },
          now,
        });
        if (!appended.ok || !appended.event) {
          throw new NativeRequestError("The action challenge event could not be journaled.", "STORAGE_WRITE_FAILED");
        }
        persistedEvent = appended.event;
        return {
          ...snapshot,
          ledger: appended.ledger,
          session: {
            ...snapshot.session,
            pendingChallenges: [...snapshot.session.pendingChallenges, pending],
          },
        };
      });
      await this.rescheduleChallengeExpiry();
      if (persistedEvent) this.criticalEvents.publishPersisted(persistedEvent);
      return await settlement;
    } catch (error) {
      if (this.actionChallengeWaiters.get(pending.challengeId) === waiter) {
        this.actionChallengeWaiters.delete(pending.challengeId);
      }
      throw error;
    } finally {
      if (this.actionChallengeWaiters.get(pending.challengeId) === waiter) {
        this.actionChallengeWaiters.delete(pending.challengeId);
      }
    }
  }

  private async cancelPendingChallengeForOperation(
    request: ScopedBrowserPerformRequest,
    code: "APPROVAL_DENIED" | "CHALLENGE_EXPIRED" | "CANCELED",
  ): Promise<void> {
    await this.cancelPendingChallenges((challenge) =>
      challenge.opId === request.opId
      && challenge.actionId === request.actionId
      && challenge.contextId === request.contextId
      && challenge.browserSessionId === request.browserSessionId
      && challenge.turnId === request.turnId,
    code);
  }

  private async terminalizeWaitingChallenge(
    request: ScopedBrowserPerformRequest,
    error: unknown,
  ): Promise<void> {
    const nativeError = error instanceof NativeRequestError ? error : null;
    const canceled = nativeError?.a0Code === "CANCELED"
      || nativeError?.a0Code === "APPROVAL_DENIED"
      || nativeError?.a0Code === "CHALLENGE_EXPIRED";
    const code = nativeError && /^[A-Z][A-Z0-9_]{0,63}$/u.test(nativeError.a0Code)
      ? nativeError.a0Code
      : "DEADLINE_EXCEEDED";
    await this.store.updateLedger((ledger) => {
      const operation = ledger.operations.find((record) =>
        record.loadGenerationId === this.store.snapshot.lifecycle.loadGenerationId
        && record.actionId === request.actionId
        && record.opId === request.opId
        && record.contextId === request.contextId
        && record.browserSessionId === request.browserSessionId
        && record.turnId === request.turnId,
      );
      if (operation?.stage !== "waiting_approval") return ledger;
      const result = transitionMutation(ledger, {
        expectedRevision: ledger.revision,
        loadGenerationId: operation.loadGenerationId,
        actionId: operation.actionId,
        expectedStage: "waiting_approval",
        stage: canceled ? "canceled" : "failed",
        safeReceipt: { outcome: "not_applied", code, leaseHandleDigest: null },
        now: Date.now(),
      });
      if (!result.ok) throw new NativeRequestError("The challenged operation could not be terminalized.", "STORAGE_WRITE_FAILED");
      return result.ledger;
    });
  }

  private async cancelPendingChallenges(
    predicate: (challenge: PendingBrowserChallenge) => boolean,
    code: "APPROVAL_DENIED" | "CHALLENGE_EXPIRED" | "CANCELED",
  ): Promise<void> {
    const canceled: PendingBrowserChallenge[] = [];
    await this.store.updateBoth((snapshot) => {
      const targets = snapshot.session.pendingChallenges.filter(predicate);
      if (targets.length === 0) return snapshot;
      let ledger = snapshot.ledger;
      for (const challenge of targets) {
        const operation = ledger.operations.find((record) =>
          record.loadGenerationId === challenge.loadGenerationId
          && record.actionId === challenge.actionId
          && record.opId === challenge.opId
          && record.contextId === challenge.contextId
          && record.browserSessionId === challenge.browserSessionId
          && record.turnId === challenge.turnId,
        );
        if (operation?.stage === "waiting_approval") {
          const result = transitionMutation(ledger, {
            expectedRevision: ledger.revision,
            loadGenerationId: challenge.loadGenerationId,
            actionId: challenge.actionId,
            expectedStage: "waiting_approval",
            stage: "canceled",
            safeReceipt: { outcome: "not_applied", code, leaseHandleDigest: null },
            now: Date.now(),
          });
          if (!result.ok) throw new NativeRequestError("The pending challenge could not be canceled durably.", "STORAGE_WRITE_FAILED");
          ledger = result.ledger;
        }
        canceled.push(challenge);
      }
      const canceledIds = new Set(canceled.map((challenge) => challenge.challengeId));
      return {
        ...snapshot,
        ledger,
        session: {
          ...snapshot.session,
          pendingChallenges: snapshot.session.pendingChallenges.filter(
            (challenge) => !canceledIds.has(challenge.challengeId),
          ),
        },
      };
    });
    await this.rescheduleChallengeExpiry();
    for (const challenge of canceled) {
      if (this.isPendingActionChallenge(challenge)) {
        this.actionChallengeWaiters.get(challenge.challengeId)?.settle({ decision: null, grant: null, code });
      } else {
        this.challengeWaiters.get(challenge.challengeId)?.settle({ decision: null, grant: null, code });
      }
    }
  }

  private async rescheduleChallengeExpiry(): Promise<void> {
    try {
      await chrome.alarms?.clear(SITE_CHALLENGE_EXPIRY_ALARM);
      const earliest = this.store.snapshot.session.pendingChallenges.reduce<number | null>(
        (minimum, challenge) => minimum === null ? challenge.expiresAtMs : Math.min(minimum, challenge.expiresAtMs),
        null,
      );
      if (earliest !== null) chrome.alarms?.create(SITE_CHALLENGE_EXPIRY_ALARM, { when: earliest });
    } catch {
      // The negotiated activation gate separately proves alarm permission. A
      // transient reschedule failure cannot re-authorize or settle a challenge.
    }
  }

  private assertNotCanceled(request: ScopedBrowserPerformRequest): void {
    this.assertTurnAcceptsOperations(request);
    const live = this.liveOperations.get(request.actionId);
    if (
      live
      && live.request.opId === request.opId
      && live.request.contextId === request.contextId
      && live.request.browserSessionId === request.browserSessionId
      && live.request.turnId === request.turnId
      && live.cancelRequested
    ) {
      throw new NativeRequestError("The browser operation was canceled before its effect.", "CANCELED");
    }
    this.assertOperationAuthority(request);
  }

  private markEffectInvoked(request: ScopedBrowserPerformRequest): void {
    this.assertNotCanceled(request);
    const live = this.liveOperations.get(request.actionId);
    if (!live || live.request.opId !== request.opId) {
      throw new NativeRequestError("The live browser operation binding was lost.", "INVALID_STATE");
    }
    live.effectInvoked = true;
  }

  private async cancelOperationCursor(live: LiveOperation, controlId: string): Promise<void> {
    const tabHandle = live.request.target?.tabHandle;
    if (!tabHandle) return;
    const lease = this.store.snapshot.session.leasesByHandle[tabHandle];
    if (
      !lease
      || !lease.identity.documentId
      || lease.contextId !== live.request.contextId
      || lease.browserSessionId !== live.request.browserSessionId
      || lease.turnId !== live.request.turnId
    ) return;
    try {
      const cancellationDigest = (await sha256(controlId)).slice(0, 32);
      await this.contentHost.command(lease, {
        commandId: `cancel:${cancellationDigest}`,
        operationId: live.request.opId,
        actionId: live.request.actionId,
        deadlineAtMs: Date.now() + 5_000,
        command: { name: "cursor.cancel", reason: "cancel" },
      });
    } catch {
      // Cursor teardown is best effort and never changes the cancellation certainty.
    }
    const current = this.currentMatchingLease(lease);
    if (current?.overlayAttached) {
      try {
        await this.persistLease({ ...current, overlayAttached: false, revision: current.revision + 1 });
      } catch {
        // Failing to persist presentation state cannot broaden browser authority.
      }
    }
  }

  async finalize(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    let request: ReturnType<typeof parseBrowserFinalizeRequest>;
    try {
      request = parseBrowserFinalizeRequest(params);
    } catch (error) {
      throw new NativeRequestError(
        error instanceof Error ? error.message : "The finalization request is malformed.",
        "INVALID_STATE",
      );
    }

    const canonicalRequestHash = await sha256(stableJson({
      contract_version: request.contractVersion,
      control_id: request.controlId,
      context_id: request.contextId,
      browser_session_id: request.browserSessionId,
      turn_id: request.turnId,
      dispositions: request.dispositions,
      reason: request.reason,
    }));
    const active = this.activeFinalizations.get(request.controlId);
    if (active) {
      if (active.canonicalRequestHash !== canonicalRequestHash) {
        throw new NativeRequestError("The finalization control identity was reused with different parameters.", "IDEMPOTENCY_CONFLICT");
      }
      return await active.promise;
    }
    const stored = this.store.snapshot.session.finalizationControls.find(
      (control) => control.controlId === request.controlId,
    );
    if (stored && stored.canonicalRequestHash !== canonicalRequestHash) {
      throw new NativeRequestError("The finalization control identity was reused with different parameters.", "IDEMPOTENCY_CONFLICT");
    }
    if (stored?.status === "completed" && stored.result) return stored.result;

    const promise = stored?.status === "pending"
      ? this.recoverPendingFinalization(request, canonicalRequestHash)
      : this.withTurnFinalizationBarrier(
          request,
          canonicalRequestHash,
          async () => await this.finalizeTurn(request),
        );
    this.activeFinalizations.set(request.controlId, { canonicalRequestHash, promise });
    try {
      return await promise;
    } finally {
      if (this.activeFinalizations.get(request.controlId)?.promise === promise) {
        this.activeFinalizations.delete(request.controlId);
      }
    }
  }

  private async withTurnFinalizationBarrier(
    request: BrowserFinalizeRequest,
    canonicalRequestHash: string,
    task: () => Promise<StoredFinalizationResult>,
  ): Promise<StoredFinalizationResult> {
    const key = this.turnKey(request);
    this.finalizingTurns.add(key);
    const live = [...this.liveOperations.values()].filter(
      (operation) => operation.request.contextId === request.contextId
        && operation.request.browserSessionId === request.browserSessionId
        && operation.request.turnId === request.turnId,
    );
    for (const operation of live) operation.cancelRequested = true;
    for (const operation of live) {
      await this.cancelPendingArtifactForOperation(operation.request, "CANCELED");
    }

    const prior = this.finalizationTails.get(key) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.catch(() => undefined).then(async () => await gate);
    this.finalizationTails.set(key, tail);
    const canceledChallenges: PendingBrowserChallenge[] = [];

    try {
      await this.store.updateBoth((snapshot) => {
        let ledger = snapshot.ledger;
        for (const operation of live) {
          if (operation.effectInvoked) continue;
          const record = ledger.operations.find((candidate) =>
            candidate.loadGenerationId === snapshot.lifecycle.loadGenerationId
            && candidate.actionId === operation.request.actionId
            && candidate.opId === operation.request.opId
            && candidate.contextId === request.contextId
            && candidate.browserSessionId === request.browserSessionId
            && candidate.turnId === request.turnId
            && !["succeeded", "failed", "canceled", "outcome_unknown"].includes(candidate.stage),
          );
          if (!record) continue;
          const canceled = transitionMutation(ledger, {
            expectedRevision: ledger.revision,
            loadGenerationId: record.loadGenerationId,
            actionId: record.actionId,
            expectedStage: record.stage,
            stage: "canceled",
            safeReceipt: { outcome: "not_applied", code: "CANCELED", leaseHandleDigest: null },
            now: Date.now(),
          });
          if (!canceled.ok) {
            throw new NativeRequestError("Turn finalization could not cancel queued browser work.", "STORAGE_WRITE_FAILED");
          }
          ledger = canceled.ledger;
        }

        const exists = snapshot.session.finalizedTurns.some((barrier) =>
          barrier.contextId === request.contextId
          && barrier.browserSessionId === request.browserSessionId
          && barrier.turnId === request.turnId,
        );
        if (!exists && snapshot.session.finalizedTurns.length >= 2_048) {
          throw new NativeRequestError("The finalized-turn barrier store is full.", "STORAGE_WRITE_FAILED");
        }
        const existingControl = snapshot.session.finalizationControls.find(
          (control) => control.controlId === request.controlId,
        );
        if (existingControl && existingControl.canonicalRequestHash !== canonicalRequestHash) {
          throw new NativeRequestError("The finalization control identity was reused with different parameters.", "IDEMPOTENCY_CONFLICT");
        }
        if (!existingControl && snapshot.session.finalizationControls.length >= 2_048) {
          throw new NativeRequestError("The finalization control receipt store is full.", "STORAGE_WRITE_FAILED");
        }
        canceledChallenges.push(...snapshot.session.pendingChallenges.filter((challenge) =>
          challenge.contextId === request.contextId
          && challenge.browserSessionId === request.browserSessionId
          && challenge.turnId === request.turnId,
        ));
        const canceledChallengeIds = new Set(canceledChallenges.map((challenge) => challenge.challengeId));
        return {
          ...snapshot,
          ledger,
          session: {
            ...snapshot.session,
            finalizedTurns: exists
              ? snapshot.session.finalizedTurns
              : [...snapshot.session.finalizedTurns, {
                  contextId: request.contextId,
                  browserSessionId: request.browserSessionId,
                  turnId: request.turnId,
                  controlId: request.controlId,
                  createdAtMs: Date.now(),
                }],
            finalizationControls: existingControl
              ? snapshot.session.finalizationControls
              : [...snapshot.session.finalizationControls, {
                  controlId: request.controlId,
                  canonicalRequestHash,
                  status: "pending",
                  result: null,
                  createdAtMs: Date.now(),
                  completedAtMs: null,
                }],
            pendingChallenges: snapshot.session.pendingChallenges.filter(
              (challenge) => !canceledChallengeIds.has(challenge.challengeId),
            ),
          },
        };
      });
      await this.rescheduleChallengeExpiry();
      for (const challenge of canceledChallenges) {
        if (this.isPendingActionChallenge(challenge)) {
          this.actionChallengeWaiters.get(challenge.challengeId)?.settle({ decision: null, grant: null, code: "CANCELED" });
        } else {
          this.challengeWaiters.get(challenge.challengeId)?.settle({ decision: null, grant: null, code: "CANCELED" });
        }
      }
      await prior.catch(() => undefined);
      await Promise.all(live.map(async (operation) => await operation.settled));
      const result = await task();
      await this.persistFinalizationResult(request, canonicalRequestHash, result);
      return result;
    } finally {
      release();
      if (this.finalizationTails.get(key) === tail) this.finalizationTails.delete(key);
    }
  }

  private async persistFinalizationResult(
    request: BrowserFinalizeRequest,
    canonicalRequestHash: string,
    result: StoredFinalizationResult,
  ): Promise<void> {
    let persistedEvent: CriticalBrowserEventRecord | null = null;
    await this.store.updateBoth((snapshot) => {
      const index = snapshot.session.finalizationControls.findIndex((control) => control.controlId === request.controlId);
      const current = snapshot.session.finalizationControls[index];
      if (index < 0 || !current || current.canonicalRequestHash !== canonicalRequestHash) {
        throw new NativeRequestError("The finalization control receipt is missing.", "STORAGE_WRITE_FAILED");
      }
      if (current.status === "completed") return snapshot;
      const controls = [...snapshot.session.finalizationControls];
      controls[index] = {
        ...current,
        status: "completed",
        result,
        completedAtMs: Date.now(),
      };
      const event = appendTurnFinalizedEvent(snapshot.ledger, {
        loadGenerationId: snapshot.lifecycle.loadGenerationId,
        contextId: request.contextId,
        browserSessionId: request.browserSessionId,
        turnId: request.turnId,
        controlId: request.controlId,
        result,
        now: Date.now(),
      });
      if (!event.ok) throw new NativeRequestError("The finalization event could not be journaled.", "STORAGE_WRITE_FAILED");
      persistedEvent = event.event;
      return {
        ...snapshot,
        ledger: event.ledger,
        session: { ...snapshot.session, finalizationControls: controls },
      };
    });
    if (persistedEvent) this.criticalEvents.publishPersisted(persistedEvent);
  }

  private async recoverPendingFinalization(
    request: BrowserFinalizeRequest,
    canonicalRequestHash: string,
  ): Promise<StoredFinalizationResult> {
    const result: StoredFinalizationResult = {
      contract_version: 1,
      control_id: request.controlId,
      closed: [],
      released: [],
      retained: [],
      already_finalized: [],
      errors: [],
    };
    const matching = Object.values(this.store.snapshot.session.leasesByHandle).filter(
      (lease) => lease.contextId === request.contextId
        && lease.browserSessionId === request.browserSessionId
        && lease.turnId === request.turnId,
    );
    for (const lease of matching) {
      if (lease.finalizationControlId === request.controlId && lease.state === "closed") {
        result.closed.push(lease.leaseId);
      } else if (lease.finalizationControlId === request.controlId && lease.state === "released") {
        result.released.push(lease.leaseId);
      } else {
        result.errors.push({ lease_id: lease.leaseId, tab_handle: lease.tabHandle, code: "OUTCOME_UNKNOWN" });
      }
    }
    await this.persistFinalizationResult(request, canonicalRequestHash, result);
    return result;
  }

  private async finalizeTurn(request: BrowserFinalizeRequest): Promise<StoredFinalizationResult> {

    const outcomes = {
      closed: [] as string[],
      released: [] as string[],
      retained: [] as Array<{ lease_id: string; tab_handle: string; reason: string }>,
      already_finalized: [] as string[],
      errors: [] as Array<{ lease_id: string; tab_handle: string; code: string }>,
    };
    const matching = Object.values(this.store.snapshot.session.leasesByHandle).filter(
      (lease) => lease.contextId === request.contextId
        && lease.browserSessionId === request.browserSessionId
        && lease.turnId === request.turnId,
    );
    const matchingLeaseIds = new Set<string>(matching.map((lease) => lease.leaseId));
    if (matchingLeaseIds.size !== matching.length) {
      throw new NativeRequestError("The finalization lease identities are ambiguous.", "LEASE_CONFLICT");
    }
    const unknownDisposition = Object.keys(request.dispositions).find((key) => !matchingLeaseIds.has(key));
    if (unknownDisposition) {
      throw new NativeRequestError(
        "A finalization disposition did not identify an exact lease in this turn.",
        "LEASE_NOT_FOUND",
      );
    }

    for (const initial of matching) {
      let current = initial;
      if (["closed", "released", "retained"].includes(current.state)) {
        outcomes.already_finalized.push(current.leaseId);
        continue;
      }
      if (current.debuggerAttached) {
        await this.removeOverlay(current);
        const detached = await this.debuggerHost.detachLease(current);
        if (!detached) {
          const retained: TabLease = {
            ...current,
            state: "retained",
            finalizationControlId: request.controlId,
            overlayAttached: false,
            retentionReason: "outcome_unknown",
            revision: current.revision + 1,
          };
          await this.persistLease(retained);
          outcomes.retained.push({
            lease_id: retained.leaseId,
            tab_handle: retained.tabHandle,
            reason: "outcome_unknown",
          });
          continue;
        }
        current = { ...current, debuggerAttached: false, revision: current.revision + 1 };
        await this.persistLease(current);
      }
      const disposition = request.dispositions[current.leaseId];
      let lease = disposition ? { ...current, disposition } : current;
      let tab = await this.tabForFinalization(lease.identity.providerTabId);
      let plan = planLeaseFinalization(lease, this.finalizationRequest(request, lease, tab));

      await this.persistLease(plan.lease);
      await this.removeOverlay(plan.lease);
      if (plan.action === "retain_tab") {
        await this.persistLease(plan.lease);
        outcomes.retained.push({ lease_id: lease.leaseId, tab_handle: lease.tabHandle, reason: plan.reason });
        continue;
      }

      const afterOverlay = this.currentMatchingLease(plan.lease);
      if (!afterOverlay) {
        outcomes.errors.push({ lease_id: lease.leaseId, tab_handle: lease.tabHandle, code: "LEASE_CONFLICT" });
        continue;
      }
      tab = await this.tabForFinalization(afterOverlay.identity.providerTabId);
      const beforeEffect = this.currentMatchingLease(afterOverlay);
      if (!beforeEffect) {
        outcomes.errors.push({ lease_id: lease.leaseId, tab_handle: lease.tabHandle, code: "LEASE_CONFLICT" });
        continue;
      }
      plan = planLeaseFinalization(beforeEffect, this.finalizationRequest(request, beforeEffect, tab));
      lease = plan.lease;
      if (plan.action === "retain_tab") {
        await this.persistLease(plan.lease);
        outcomes.retained.push({ lease_id: lease.leaseId, tab_handle: lease.tabHandle, reason: plan.reason });
        continue;
      }

      try {
        if (plan.action === "close_exact_tab") {
          await chrome.tabs.remove(plan.providerTabId);
          const completed = applyFinalizationOutcome(plan.lease, request.controlId, "closed");
          await this.persistLease(completed);
          outcomes.closed.push(lease.leaseId);
        } else {
          if (plan.ungroup) await chrome.tabs.ungroup(plan.providerTabId);
          const completed = applyFinalizationOutcome(plan.lease, request.controlId, "released");
          await this.persistLease(completed);
          outcomes.released.push(lease.leaseId);
        }
      } catch {
        const unknown = applyFinalizationOutcome(plan.lease, request.controlId, "result_lost");
        await this.persistLease(unknown);
        outcomes.errors.push({ lease_id: lease.leaseId, tab_handle: lease.tabHandle, code: "OUTCOME_UNKNOWN" });
      }
    }

    return { contract_version: 1, control_id: request.controlId, ...outcomes };
  }

  private async tabForFinalization(providerTabId: number): Promise<chrome.tabs.Tab | null> {
    try {
      return await chrome.tabs.get(providerTabId);
    } catch {
      return null;
    }
  }

  private finalizationRequest(
    request: ReturnType<typeof parseBrowserFinalizeRequest>,
    lease: TabLease,
    tab: chrome.tabs.Tab | null,
  ): Parameters<typeof planLeaseFinalization>[1] {
    return {
      tabHandle: lease.tabHandle,
      loadGenerationId: this.store.snapshot.lifecycle.loadGenerationId,
      contextId: request.contextId,
      browserSessionId: request.browserSessionId,
      turnId: request.turnId,
      controlId: request.controlId,
      browserInstanceId: this.store.snapshot.session.browserInstanceId,
      providerTabId: lease.identity.providerTabId,
      providerWindowId: lease.identity.providerWindowId,
      tabExists: Boolean(tab && typeof tab.id === "number"),
      identityIntact: Boolean(
        tab
        && tab.id === lease.identity.providerTabId
        && tab.windowId === lease.identity.providerWindowId,
      ),
      extensionOwnedGroupIntact: Boolean(tab && tab.groupId === lease.providerGroupId),
    };
  }

  async observeTabRemoved(providerTabId: number): Promise<void> {
    const leases = Object.values(this.store.snapshot.session.leasesByHandle).filter(
      (lease) =>
        lease.identity.providerTabId === providerTabId
        && (lease.state === "active" || lease.state === "finalizing"),
    );
    for (const lease of leases) {
      await this.persistLease({
        ...lease,
        state: "closed",
        overlayAttached: false,
        debuggerAttached: false,
        expectedGroupActionId: null,
        expectedGroupWindowId: null,
        expectedProviderGroupId: null,
        revision: lease.revision + 1,
      });
    }
  }

  async observeDebuggerDetached(source: chrome.debugger.Debuggee): Promise<void> {
    const binding = this.debuggerHost.observeDetached(source);
    if (!binding) return;
    const pending = this.pendingArtifacts.get(binding.actionId);
    if (
      pending
      && pending.binding.actionId === binding.actionId
      && pending.request.target?.tabHandle === binding.tabHandle
    ) await this.abortPendingArtifact(pending, "OUTCOME_UNKNOWN", "DEBUGGER_DETACHED");
    const lease = this.store.snapshot.session.leasesByHandle[binding.tabHandle];
    if (
      !lease
      || lease.leaseId !== binding.leaseId
      || lease.identity.providerTabId !== binding.providerTabId
      || !lease.debuggerAttached
    ) return;
    await this.persistLease({ ...lease, debuggerAttached: false, revision: lease.revision + 1 });
  }

  async observeTabReplaced(addedProviderTabId: number, removedProviderTabId: number): Promise<void> {
    const lease = Object.values(this.store.snapshot.session.leasesByHandle).find(
      (candidate) => candidate.identity.providerTabId === removedProviderTabId,
    );
    if (!lease) return;
    await this.persistLease(transferLeaseOnTabReplacement(lease, removedProviderTabId, addedProviderTabId));
  }

  async observeTabUpdated(
    providerTabId: number,
    changeInfo: chrome.tabs.TabChangeInfo,
    tab: chrome.tabs.Tab,
  ): Promise<void> {
    const lease = Object.values(this.store.snapshot.session.leasesByHandle).find(
      (candidate) => candidate.identity.providerTabId === providerTabId && candidate.state === "active",
    );
    if (!lease) return;

    if (changeInfo.pinned !== undefined) {
      await this.takeOver(lease, changeInfo.pinned ? "pinned" : "unpinned");
      return;
    }
    if (changeInfo.groupId !== undefined) {
      const observedGroupId = changeInfo.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE
        ? null
        : changeInfo.groupId;
      const correlatedActionId = lease.expectedGroupActionId
        && lease.expectedGroupWindowId === tab.windowId
        && (lease.expectedProviderGroupId === "new" || lease.expectedProviderGroupId === observedGroupId)
          ? lease.expectedGroupActionId
          : null;
      const observed = observeTabGroupChange(lease, {
        providerWindowId: tab.windowId,
        providerGroupId: observedGroupId,
        correlatedActionId,
      });
      if (observed !== lease) {
        if (observed.userIntervened) {
          await this.takeOver(lease, observed.userTakeoverReason || "other");
        } else {
          await this.persistLease(observed);
        }
      }
      return;
    }
    if (changeInfo.url) {
      let nextUrl: URL | null = null;
      try {
        nextUrl = exactHttpUrl(changeInfo.url);
      } catch {
        // A restricted or malformed destination cannot retain automation authority.
      }
      const approved = this.approvedNavigations.get(providerTabId);
      if (approved) {
        const exactApproval = nextUrl
          && nextUrl.href === approved.destinationHref
          && nextUrl.origin === approved.destinationOrigin
          && lease.leaseId === approved.leaseId
          && lease.tabHandle === approved.tabHandle
          && lease.siteOrigin === approved.sourceOrigin
          && lease.identity.documentId === approved.documentId
          && lease.identity.documentEpoch === approved.documentEpoch;
        if (exactApproval && nextUrl) {
          this.approvedNavigations.delete(providerTabId);
          const beforeRelease = this.currentMatchingLease(lease);
          if (!beforeRelease || beforeRelease.state !== "active") return;
          await this.removeOverlay(beforeRelease);
          const current = this.currentMatchingLease(beforeRelease);
          if (!current || current.state !== "active") return;
          await this.persistLease({
            ...current,
            siteOrigin: approved.destinationOrigin,
            identity: {
              ...current.identity,
              documentId: null,
              documentEpoch: current.identity.documentEpoch + 1,
            },
            overlayAttached: false,
            revision: current.revision + 1,
          }, nextUrl.href);
          return;
        }
        this.approvedNavigations.delete(providerTabId);
      }
      const nextOrigin = nextUrl?.origin || "";
      if (nextOrigin !== lease.siteOrigin) {
        await this.takeOver(lease, "other");
        return;
      }
      const beforeRelease = this.currentMatchingLease(lease);
      if (!beforeRelease || beforeRelease.state !== "active") return;
      await this.removeOverlay(beforeRelease);
      const current = this.currentMatchingLease(beforeRelease);
      if (!current || current.state !== "active") return;
      await this.persistLease({
        ...current,
        identity: {
          ...current.identity,
          documentId: null,
          documentEpoch: current.identity.documentEpoch + 1,
        },
        overlayAttached: false,
        revision: current.revision + 1,
      }, nextUrl?.href);
    }
  }

  async observeTabMoved(providerTabId: number): Promise<void> {
    const lease = Object.values(this.store.snapshot.session.leasesByHandle).find(
      (candidate) => candidate.identity.providerTabId === providerTabId && candidate.state === "active",
    );
    if (!lease) return;
    if (lease.expectedGroupActionId) {
      let tab: chrome.tabs.Tab | null = null;
      try {
        tab = await chrome.tabs.get(providerTabId);
      } catch {
        tab = null;
      }
      const current = this.currentMatchingLease(lease);
      if (!current || current.state !== "active") return;
      const observedGroupId = tab && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? tab.groupId : null;
      if (tab) {
        const observed = observeTabGroupChange(current, {
          providerWindowId: tab.windowId,
          providerGroupId: observedGroupId,
          correlatedActionId: current.expectedGroupActionId,
        });
        if (observed !== current && !observed.userIntervened) {
          await this.persistLease(observed);
          return;
        }
      }
    }
    await this.takeOver(lease, "moved");
  }

  async observeWindowChange(providerTabId: number): Promise<void> {
    const lease = Object.values(this.store.snapshot.session.leasesByHandle).find(
      (candidate) => candidate.identity.providerTabId === providerTabId && candidate.state === "active",
    );
    if (lease) await this.takeOver(lease, "window_changed");
  }

  private status(): Record<string, unknown> {
    const snapshot = this.store.snapshot;
    const { actions, features } = this.currentNegotiation();
    return {
      runtime_contract: "a0.browser-bridge.mv3-runtime.v1",
      state: snapshot.session.connection.state,
      reason_code: snapshot.session.connection.reasonCode,
      load_generation_id: snapshot.lifecycle.loadGenerationId,
      capabilities: features,
      actions,
      active_lease_count: Object.values(snapshot.session.leasesByHandle).filter((lease) => lease.state === "active").length,
    };
  }

  private list(request: ScopedBrowserPerformRequest): Record<string, unknown> {
    const tabs = Object.values(this.store.snapshot.session.leasesByHandle)
      .filter((lease) =>
        lease.contextId === request.contextId
        && lease.browserSessionId === request.browserSessionId
        && lease.state === "active",
      )
      .map((lease) => ({
        lease_id: lease.leaseId,
        browser_id: lease.tabHandle,
        tab_handle: lease.tabHandle,
        origin: lease.siteOrigin,
        ownership: lease.origin,
        disposition: lease.disposition,
        state: lease.state,
      }));
    return { tabs, unavailable_count: 0 };
  }

  private async state(request: ScopedBrowserPerformRequest): Promise<Record<string, unknown>> {
    const lease = leaseForRequest(this.store.snapshot, request);
    const { tab } = await this.exactLeasedTab(lease);
    return {
      lease_id: lease.leaseId,
      browser_id: lease.tabHandle,
      tab_handle: lease.tabHandle,
      url: tab.url || "",
      title: tab.title || "",
      active: Boolean(tab.active),
      status: tab.status || "unknown",
      disposition: lease.disposition,
    };
  }

  private async screenshot(request: ScopedBrowserPerformRequest): Promise<{
    result: Record<string, unknown>;
    descriptor: ArtifactDescriptor;
  }> {
    requireOriginGrant(request);
    exactActionArgs(request.args, [], ["format", "quality"]);
    let captureOptions: ScreenshotCaptureOptions;
    if (request.args.format === undefined || request.args.format === "png") {
      if (request.args.quality !== undefined) {
        throw new NativeRequestError("Screenshot quality is supported only for JPEG capture.", "INVALID_STATE");
      }
      captureOptions = { format: "png" };
    } else if (
      request.args.format === "jpeg"
      && Number.isSafeInteger(request.args.quality)
      && Number(request.args.quality) >= 20
      && Number(request.args.quality) <= 95
    ) {
      captureOptions = { format: "jpeg", quality: Number(request.args.quality) };
    } else {
      throw new NativeRequestError("Screenshot format or JPEG quality is invalid.", "INVALID_STATE");
    }
    if (this.pendingArtifacts.size >= 32 || this.pendingArtifacts.has(request.actionId)) {
      throw new NativeRequestError("The bounded screenshot transfer queue is full or conflicted.", "INVALID_STATE");
    }
    let lease = leaseForRequest(this.store.snapshot, request);
    await this.exactLeasedTab(lease);
    if (lease.debuggerAttached) {
      throw new NativeRequestError("The exact lease has unresolved debugger cleanup debt.", "OUTCOME_UNKNOWN", "unknown");
    }

    const binding: OutputArtifactBinding = {
      contextId: request.contextId,
      browserSessionId: request.browserSessionId,
      turnId: request.turnId,
      actionId: request.actionId,
      opId: request.opId,
      artifactId: `a0art1.${crypto.randomUUID()}`,
      direction: "output",
      purpose: "screenshot",
    };
    const pending: PendingOutputArtifact = {
      request,
      binding,
      controller: new AbortController(),
      beginSent: false,
      completed: false,
      abortSent: false,
      failureCode: null,
    };
    this.pendingArtifacts.set(request.actionId, pending);
    let debuggerBinding: DebuggerLeaseBinding | null = null;

    try {
      this.assertOperationAuthority(request);
      this.assertNotCanceled(request);
      if (lease.identity.documentId) {
        this.assertOperationAuthority(request);
        const cursor = await this.contentHost.command(lease, {
          commandId: `screenshot-cursor:${request.actionId}`,
          operationId: request.opId,
          actionId: request.actionId,
          deadlineAtMs: request.deadlineAtMs,
          assertAuthority: () => this.assertOperationAuthority(request),
          command: { name: "cursor.cancel", reason: "pause" },
        });
        if (cursor.result?.state !== "cancelled") {
          throw new NativeRequestError("The page cursor did not confirm teardown.", "DOCUMENT_MISMATCH");
        }
      }
      this.assertOperationAuthority(request);
      this.assertNotCanceled(request);
      lease = this.refreshExactOperationLease(request, lease);
      await this.exactLeasedTab(lease);
      if (lease.overlayAttached) {
        lease = { ...lease, overlayAttached: false, revision: lease.revision + 1 };
        await this.persistLease(lease);
      }

      this.markEffectInvoked(request);
      lease = this.refreshExactOperationLease(request, lease);
      lease = { ...lease, debuggerAttached: true, revision: lease.revision + 1 };
      await this.persistLease(lease);
      debuggerBinding = debuggerBindingForLease(lease, request.actionId);
      this.assertOperationAuthority(request);
      await this.debuggerHost.attach(debuggerBinding);

      this.assertOperationAuthority(request);
      this.assertNotCanceled(request);
      lease = this.refreshExactOperationLease(request, lease);
      await this.exactLeasedTab(lease);
      this.assertOperationAuthority(request);
      const encoded = await this.debuggerHost.capture(debuggerBinding, captureOptions);

      const detached = await this.debuggerHost.detach(debuggerBinding);
      if (!detached) {
        throw new NativeRequestError("Chrome did not confirm debugger cleanup.", "OUTCOME_UNKNOWN", "unknown");
      }
      const detachedBinding = debuggerBinding;
      debuggerBinding = null;
      const detachedLease = this.currentDebuggerLease(detachedBinding);
      if (!detachedLease) {
        throw new NativeRequestError("The lease identity changed during debugger cleanup.", "TAB_IDENTITY_MISMATCH", "unknown");
      }
      lease = detachedLease;
      lease = { ...lease, debuggerAttached: false, revision: lease.revision + 1 };
      await this.persistLease(lease);

      this.assertOperationAuthority(request);
      this.assertNotCanceled(request);
      const bytes = this.decodeScreenshot(encoded);
      const descriptor: ArtifactDescriptor = {
        artifact_id: binding.artifactId,
        mime_type: captureOptions.format === "jpeg" ? "image/jpeg" : "image/png",
        byte_count: bytes.byteLength,
        sha256: `sha256:${await this.sha256Bytes(bytes)}`,
        purpose: "screenshot",
      };
      await this.streamArtifact(pending, bytes, descriptor);
      pending.completed = true;
      return {
        result: {
          lease_id: lease.leaseId,
          browser_id: lease.tabHandle,
          tab_handle: lease.tabHandle,
          artifact_id: descriptor.artifact_id,
        },
        descriptor,
      };
    } catch (error) {
      if (debuggerBinding) {
        const detached = await this.debuggerHost.detach(debuggerBinding);
        if (detached) {
          const current = this.currentDebuggerLease(debuggerBinding);
          if (current?.debuggerAttached) {
            await this.persistLease({ ...current, debuggerAttached: false, revision: current.revision + 1 });
          }
        }
      }
      if (!pending.completed) await this.abortPendingArtifact(pending, this.artifactAbortReason(error));
      if (pending.failureCode) {
        throw new NativeRequestError(
          "The screenshot operation lost its exact runtime authority.",
          pending.failureCode,
          pending.failureCode === "CANCELED" ? "not_applied" : "unknown",
        );
      }
      if (error instanceof NativeRequestError) throw error;
      if (error instanceof Error && error.name === "NativeRequestCancelledError") {
        throw new NativeRequestError("The screenshot transfer was canceled.", "CANCELED");
      }
      if (error instanceof Error && error.name === "NativeRequestTimeoutError") {
        throw new NativeRequestError("The screenshot transfer deadline expired.", "DEADLINE_EXCEEDED");
      }
      if (error instanceof Error && (error.name === "NativeConnectionError" || error.name === "NativeRpcError")) {
        throw new NativeRequestError("The screenshot artifact transport was lost.", "CONNECTION_LOST", "unknown", true);
      }
      throw new NativeRequestError("The screenshot outcome is unknown.", "OUTCOME_UNKNOWN", "unknown");
    } finally {
      if (this.pendingArtifacts.get(request.actionId) === pending) this.pendingArtifacts.delete(request.actionId);
    }
  }

  private async hover(request: ScopedBrowserPerformRequest): Promise<Record<string, unknown>> {
    requireOriginGrant(request);
    exactActionArgs(request.args, ["ref"]);
    if (typeof request.args.ref !== "string" || request.args.ref.length === 0 || request.args.ref.length > 128) {
      throw new NativeRequestError("Hover requires a bounded opaque element reference.", "INVALID_STATE");
    }
    let lease = leaseForRequest(this.store.snapshot, request);
    await this.exactLeasedTab(lease);
    lease = await this.bindContentLease(lease, request);
    this.assertNotCanceled(request);
    lease = this.refreshExactOperationLease(request, lease);
    if (lease.debuggerAttached) {
      throw new NativeRequestError("The exact lease has unresolved debugger cleanup debt.", "OUTCOME_UNKNOWN", "unknown");
    }
    const mutation = await this.prepareLeasedMutation(request, "hover");
    if (mutation.disposition === "replay_applied") {
      return {
        lease_id: lease.leaseId,
        browser_id: lease.tabHandle,
        tab_handle: lease.tabHandle,
        document_epoch: String(lease.identity.documentEpoch),
        ref: request.args.ref,
      };
    }

    let stage: "prepared" | "effect_started" | "terminal" = "prepared";
    let debuggerBinding: DebuggerLeaseBinding | null = null;
    let effectConfirmed = false;
    try {
      this.assertOperationAuthority(request);
      this.assertNotCanceled(request);
      lease = this.refreshExactOperationLease(request, lease);
      await this.exactLeasedTab(lease);
      lease = { ...lease, debuggerAttached: true, revision: lease.revision + 1 };
      await this.persistLease(lease);
      debuggerBinding = debuggerBindingForLease(lease, request.actionId);
      this.assertOperationAuthority(request);
      await this.debuggerHost.attach(debuggerBinding);

      this.assertOperationAuthority(request);
      this.assertNotCanceled(request);
      lease = this.refreshExactOperationLease(request, lease);
      await this.exactLeasedTab(lease);
      this.assertOperationAuthority(request);
      const target = await this.contentHost.command(lease, {
        commandId: `hover-target:${request.actionId}`,
        operationId: request.opId,
        actionId: request.actionId,
        deadlineAtMs: request.deadlineAtMs,
        assertAuthority: () => this.assertOperationAuthority(request),
        command: { name: "target.prepare_hover", element_ref: request.args.ref },
      });
      if (
        target.result?.state !== "hover_ready"
        || !Number.isFinite(target.result.x)
        || !Number.isFinite(target.result.y)
        || Number(target.result.x) < 0
        || Number(target.result.y) < 0
        || Number(target.result.x) > 100_000
        || Number(target.result.y) > 100_000
      ) throw new NativeRequestError("The page runtime did not return exact hover geometry.", "INVALID_STATE");
      lease = this.refreshExactOperationLease(request, lease);
      if (!lease.overlayAttached) {
        lease = { ...lease, overlayAttached: true, revision: lease.revision + 1 };
        await this.persistLease(lease);
      }

      this.assertOperationAuthority(request);
      this.assertNotCanceled(request);
      lease = this.refreshExactOperationLease(request, lease);
      await this.exactLeasedTab(lease);
      await this.transitionMutationRecord(request.actionId, "prepared", "effect_started");
      stage = "effect_started";
      this.markEffectInvoked(request);
      this.assertOperationAuthority(request);
      await this.debuggerHost.dispatchHover(debuggerBinding, {
        x: Number(target.result.x),
        y: Number(target.result.y),
      });
      effectConfirmed = true;

      lease = this.refreshExactOperationLease(request, lease);
      await this.exactLeasedTab(lease);
      this.assertOperationAuthority(request);
      const activated = await this.contentHost.command(lease, {
        commandId: `hover-activate:${request.actionId}`,
        operationId: request.opId,
        actionId: request.actionId,
        deadlineAtMs: request.deadlineAtMs,
        assertAuthority: () => this.assertOperationAuthority(request),
        command: { name: "cursor.activate" },
      });
      if (activated.result?.state !== "activated") {
        throw new NativeRequestError("The illuminated cursor did not confirm hover activation.", "OUTCOME_UNKNOWN", "unknown");
      }

      const detached = await this.debuggerHost.detach(debuggerBinding);
      if (!detached) {
        throw new NativeRequestError("Chrome did not confirm debugger cleanup after hover.", "OUTCOME_UNKNOWN", "unknown");
      }
      const detachedBinding = debuggerBinding;
      debuggerBinding = null;
      const detachedLease = this.currentDebuggerLease(detachedBinding);
      if (!detachedLease) {
        throw new NativeRequestError("The lease identity changed during hover cleanup.", "TAB_IDENTITY_MISMATCH", "unknown");
      }
      lease = { ...detachedLease, debuggerAttached: false, revision: detachedLease.revision + 1 };
      await this.persistLease(lease);
      await this.transitionMutationRecord(request.actionId, "effect_started", "succeeded", {
        outcome: "applied",
        code: null,
        leaseHandleDigest: await sha256(lease.tabHandle),
      });
      stage = "terminal";
      return {
        lease_id: lease.leaseId,
        browser_id: lease.tabHandle,
        tab_handle: lease.tabHandle,
        document_epoch: String(lease.identity.documentEpoch),
        ref: request.args.ref,
      };
    } catch (error) {
      if (debuggerBinding) {
        const detached = await this.debuggerHost.detach(debuggerBinding);
        if (detached) {
          const current = this.currentDebuggerLease(debuggerBinding);
          if (current?.debuggerAttached) {
            await this.persistLease({ ...current, debuggerAttached: false, revision: current.revision + 1 });
          }
        }
      }
      const live = this.liveOperations.get(request.actionId);
      if (live) await this.cancelOperationCursor(live, `hover-failure-${request.actionId}`);
      if (stage !== "terminal") {
        try {
          await this.transitionMutationRecord(
            request.actionId,
            stage,
            stage === "prepared" ? "failed" : "outcome_unknown",
            {
              outcome: stage === "prepared" ? "not_applied" : "unknown",
              code: stage === "prepared"
                ? error instanceof NativeRequestError ? error.a0Code : "INTERNAL_ERROR"
                : "OUTCOME_UNKNOWN",
              leaseHandleDigest: await sha256(lease.tabHandle),
            },
          );
          stage = "terminal";
        } catch {
          // A failed terminal write cannot make a debugger/input outcome safe to replay.
        }
      }
      if (error instanceof NativeRequestError) {
        if (effectConfirmed && error.outcome === "not_applied") {
          throw new NativeRequestError(error.message, "OUTCOME_UNKNOWN", "unknown");
        }
        throw error;
      }
      throw new NativeRequestError(
        effectConfirmed ? "The hover outcome is unknown." : "The hover operation failed before dispatch.",
        effectConfirmed ? "OUTCOME_UNKNOWN" : "INTERNAL_ERROR",
        effectConfirmed ? "unknown" : "not_applied",
      );
    }
  }

  private async click(request: ScopedBrowserPerformRequest, upload = false): Promise<Record<string, unknown>> {
    requireOriginGrant(request);
    exactActionArgs(request.args, upload ? ["ref", "expected_action_class", "artifact_id", "mime_type", "byte_count", "sha256"] : ["ref", "expected_action_class"]);
    if (upload && (request.args.expected_action_class !== "external_side_effect"
      || typeof request.args.artifact_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(request.args.artifact_id)
      || typeof request.args.mime_type !== "string" || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(request.args.mime_type)
      || !Number.isSafeInteger(request.args.byte_count) || Number(request.args.byte_count) < 1 || Number(request.args.byte_count) > 25 * 1024 * 1024
      || typeof request.args.sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(request.args.sha256)
      || !this.artifactTransport.inputArtifact || !this.debuggerHost.setInputFile)) {
      throw new NativeRequestError("Upload requires a verified bounded artifact and an exact file-input consumer.", "INVALID_STATE");
    }
    if (
      typeof request.args.ref !== "string"
      || request.args.ref.length === 0
      || request.args.ref.length > 128
      || (request.args.expected_action_class !== "reversible_input"
        && request.args.expected_action_class !== "sensitive_input"
        && request.args.expected_action_class !== "external_side_effect"
        && request.args.expected_action_class !== "unknown")
    ) throw new NativeRequestError("Click requires a bounded ref and expected action class.", "INVALID_STATE");
    if (request.policy.actionGrantId !== null) {
      throw new NativeRequestError("Opaque click preauthorization is not independently verifiable.", "APPROVAL_REQUIRED");
    }
    const reference = request.args.ref;
    const expectedClass = request.args.expected_action_class;
    let lease = leaseForRequest(this.store.snapshot, request);
    await this.exactLeasedTab(lease);
    lease = await this.bindContentLease(lease, request);
    this.assertNotCanceled(request);
    lease = this.refreshExactOperationLease(request, lease);
    if (lease.debuggerAttached) {
      throw new NativeRequestError("The exact lease has unresolved debugger cleanup debt.", "OUTCOME_UNKNOWN", "unknown");
    }
    const mutation = await this.prepareLeasedMutation(request, upload ? "upload_file" : "click");
    if (mutation.disposition === "replay_applied") {
      return {
        lease_id: lease.leaseId,
        browser_id: lease.tabHandle,
        tab_handle: lease.tabHandle,
        document_epoch: String(lease.identity.documentEpoch),
        ref: reference,
        action_class: expectedClass === "reversible_input" ? "unknown" : expectedClass,
      };
    }

    let stage: "prepared" | "waiting_approval" | "effect_started" | "terminal" = "prepared";
    let debuggerBinding: DebuggerLeaseBinding | null = null;
    let effectConfirmed = false;
    let effectiveClass: "reversible_input" | ConsequentialActionClass = "unknown";
    let grantExpiresAtMs: number | null = null;
    try {
      this.assertOperationAuthority(request);
      this.assertNotCanceled(request);
      lease = this.refreshExactOperationLease(request, lease);
      await this.exactLeasedTab(lease);
      this.assertOperationAuthority(request);
      const prepared = await this.contentHost.command(lease, {
        commandId: `click-target:${request.actionId}`,
        operationId: request.opId,
        actionId: request.actionId,
        deadlineAtMs: request.deadlineAtMs,
        assertAuthority: () => this.assertOperationAuthority(request),
        command: { name: upload ? "target.prepare_upload" : "target.prepare_click", element_ref: reference },
      });
      const initial = this.parseClickTarget(prepared.result);
      effectiveClass = this.effectiveClickClass(expectedClass, initial.actionClass);
      lease = this.refreshExactOperationLease(request, lease);
      if (!lease.overlayAttached) {
        lease = { ...lease, overlayAttached: true, revision: lease.revision + 1 };
        await this.persistLease(lease);
      }

      if (effectiveClass !== "reversible_input") {
        const settlement = await this.awaitActionChallenge(
          request,
          lease,
          effectiveClass,
          initial.targetFingerprint,
          mutation.canonicalParameterHash,
          "none",
          upload ? "Allow Agent Zero to share the selected attachment with this site? File selection can immediately upload it." : undefined,
        );
        stage = "waiting_approval";
        if (settlement.code || settlement.decision !== "approve_once" || !settlement.grant) {
          throw new NativeRequestError(
            settlement.code === "CHALLENGE_EXPIRED"
              ? "The action challenge expired before approval."
              : settlement.code === "CANCELED"
                ? "The action challenge was canceled before approval."
                : "The click was declined by Agent Zero.",
            settlement.code || "APPROVAL_DENIED",
          );
        }
        if (Date.now() >= settlement.grant.expiresAtMs) {
          throw new NativeRequestError("The exact click grant expired before input dispatch.", "CHALLENGE_EXPIRED");
        }
        grantExpiresAtMs = settlement.grant.expiresAtMs;
      }

      this.assertOperationAuthority(request);
      this.assertNotCanceled(request);
      lease = this.refreshExactOperationLease(request, lease);
      await this.exactLeasedTab(lease);
      let inputArtifact: VerifiedInputArtifact | null = null;
      if (upload) {
        inputArtifact = await this.artifactTransport.inputArtifact!({
          contextId: request.contextId, browserSessionId: request.browserSessionId, turnId: request.turnId,
          actionId: request.actionId, opId: request.opId, artifactId: String(request.args.artifact_id),
        }, { timeoutMs: this.artifactTimeout(request) });
        this.assertOperationAuthority(request);
        this.assertNotCanceled(request);
        if (inputArtifact.descriptor.sha256 !== request.args.sha256
          || inputArtifact.descriptor.byte_count !== request.args.byte_count
          || inputArtifact.descriptor.mime_type !== request.args.mime_type) {
          throw new NativeRequestError("The private input does not match the approved attachment.", "INVALID_STATE");
        }
        lease = this.refreshExactOperationLease(request, lease);
        await this.exactLeasedTab(lease);
      }
      lease = { ...lease, debuggerAttached: true, revision: lease.revision + 1 };
      await this.persistLease(lease);
      debuggerBinding = debuggerBindingForLease(lease, request.actionId);
      this.assertOperationAuthority(request);
      await this.debuggerHost.attach(debuggerBinding);

      this.assertOperationAuthority(request);
      this.assertNotCanceled(request);
      lease = this.refreshExactOperationLease(request, lease);
      await this.exactLeasedTab(lease);
      let beforePress = await this.revalidateClickTarget(request, lease, reference, initial.targetFingerprint, initial.actionClass, upload);
      let uploadNode: number | null = null;
      if (upload) {
        uploadNode = await this.debuggerHost.resolveBackendNodeAtPoint(debuggerBinding, beforePress);
        beforePress = await this.revalidateClickTarget(request, lease, reference, initial.targetFingerprint, initial.actionClass, true);
        const currentNode = await this.debuggerHost.resolveBackendNodeAtPoint(debuggerBinding, beforePress);
        if (currentNode !== uploadNode) throw new NativeRequestError("The approved file field changed.", "DOCUMENT_MISMATCH");
      }
      await this.transitionMutationRecord(request.actionId, stage, "effect_started");
      stage = "effect_started";
      this.markEffectInvoked(request);
      this.assertOperationAuthority(request);
      if (upload) {
        await this.debuggerHost.setInputFile!(debuggerBinding, uploadNode!, inputArtifact!, () => {
          if (grantExpiresAtMs === null || Date.now() >= grantExpiresAtMs) throw new NativeRequestError("The attachment sharing approval expired.", "CHALLENGE_EXPIRED");
          this.assertOperationAuthority(request);
          this.assertNotCanceled(request);
          this.refreshExactOperationLease(request, lease);
        });
      } else await this.debuggerHost.dispatchClickPhase(debuggerBinding, "mousePressed", beforePress);
      effectConfirmed = true;

      this.assertOperationAuthority(request);
      this.assertNotCanceled(request);
      lease = this.refreshExactOperationLease(request, lease);
      await this.exactLeasedTab(lease);
      if (!upload) {
        const beforeRelease = await this.revalidateClickTarget(request, lease, reference, initial.targetFingerprint, initial.actionClass);
        this.assertOperationAuthority(request);
        await this.debuggerHost.dispatchClickPhase(debuggerBinding, "mouseReleased", beforeRelease);
      }

      lease = this.refreshExactOperationLease(request, lease);
      await this.exactLeasedTab(lease);
      this.assertOperationAuthority(request);
      const activated = await this.contentHost.command(lease, {
        commandId: `click-activate:${request.actionId}`,
        operationId: request.opId,
        actionId: request.actionId,
        deadlineAtMs: request.deadlineAtMs,
        assertAuthority: () => this.assertOperationAuthority(request),
        command: { name: "cursor.activate" },
      });
      if (activated.result?.state !== "activated") {
        throw new NativeRequestError("The illuminated cursor did not confirm click activation.", "OUTCOME_UNKNOWN", "unknown");
      }

      const detached = await this.debuggerHost.detach(debuggerBinding);
      if (!detached) {
        throw new NativeRequestError("Chrome did not confirm debugger cleanup after click.", "OUTCOME_UNKNOWN", "unknown");
      }
      const detachedBinding = debuggerBinding;
      debuggerBinding = null;
      const detachedLease = this.currentDebuggerLease(detachedBinding);
      if (!detachedLease) {
        throw new NativeRequestError("The lease identity changed during click cleanup.", "TAB_IDENTITY_MISMATCH", "unknown");
      }
      lease = { ...detachedLease, debuggerAttached: false, revision: detachedLease.revision + 1 };
      await this.persistLease(lease);
      await this.transitionMutationRecord(request.actionId, "effect_started", "succeeded", {
        outcome: "applied",
        code: null,
        leaseHandleDigest: await sha256(lease.tabHandle),
      });
      stage = "terminal";
      return {
        lease_id: lease.leaseId,
        browser_id: lease.tabHandle,
        tab_handle: lease.tabHandle,
        document_epoch: String(lease.identity.documentEpoch),
        ref: reference,
        action_class: effectiveClass,
      };
    } catch (error) {
      if (debuggerBinding) {
        const detached = await this.debuggerHost.detach(debuggerBinding);
        if (detached) {
          const current = this.currentDebuggerLease(debuggerBinding);
          if (current?.debuggerAttached) {
            await this.persistLease({ ...current, debuggerAttached: false, revision: current.revision + 1 });
          }
        }
      }
      const live = this.liveOperations.get(request.actionId);
      if (live) await this.cancelOperationCursor(live, `click-failure-${request.actionId}`);
      if (stage !== "terminal") {
        const currentOperation = this.store.snapshot.ledger.operations.find((record) =>
          record.loadGenerationId === this.store.snapshot.lifecycle.loadGenerationId
          && record.actionId === request.actionId,
        );
        if (currentOperation && !["succeeded", "failed", "canceled", "outcome_unknown"].includes(currentOperation.stage)) {
          const currentStage = currentOperation.stage;
          try {
            await this.transitionMutationRecord(
              request.actionId,
              currentStage,
              effectConfirmed || currentStage === "effect_started" ? "outcome_unknown" : "failed",
              {
                outcome: effectConfirmed || currentStage === "effect_started" ? "unknown" : "not_applied",
                code: effectConfirmed || currentStage === "effect_started"
                  ? "OUTCOME_UNKNOWN"
                  : error instanceof NativeRequestError ? error.a0Code : "INTERNAL_ERROR",
                leaseHandleDigest: await sha256(lease.tabHandle),
              },
            );
            stage = "terminal";
          } catch {
            // A failed terminal write cannot make trusted input safe to replay.
          }
        }
      }
      if (error instanceof NativeRequestError) {
        if (effectConfirmed && error.outcome === "not_applied") {
          throw new NativeRequestError(error.message, "OUTCOME_UNKNOWN", "unknown");
        }
        throw error;
      }
      throw new NativeRequestError(
        effectConfirmed ? "The click outcome is unknown." : "The click failed before trusted input.",
        effectConfirmed ? "OUTCOME_UNKNOWN" : "INTERNAL_ERROR",
        effectConfirmed ? "unknown" : "not_applied",
      );
    }
  }

  private parseClickTarget(result: Record<string, unknown> | undefined): {
    x: number;
    y: number;
    actionClass: "reversible_input" | ConsequentialActionClass;
    targetFingerprint: string;
  } {
    if (
      result?.state !== "click_ready"
      || !Number.isFinite(result.x)
      || !Number.isFinite(result.y)
      || Number(result.x) < 0
      || Number(result.y) < 0
      || Number(result.x) > 100_000
      || Number(result.y) > 100_000
      || (result.action_class !== "reversible_input"
        && result.action_class !== "sensitive_input"
        && result.action_class !== "external_side_effect"
        && result.action_class !== "unknown")
      || typeof result.target_fingerprint !== "string"
      || !/^[0-9a-f]{64}$/u.test(result.target_fingerprint)
    ) throw new NativeRequestError("The page runtime did not return an exact semantic click target.", "INVALID_STATE");
    return {
      x: Number(result.x),
      y: Number(result.y),
      actionClass: result.action_class,
      targetFingerprint: result.target_fingerprint,
    };
  }

  private async type(request: ScopedBrowserPerformRequest): Promise<Record<string, unknown>> {
    requireOriginGrant(request);
    exactActionArgs(request.args, ["ref", "text", "text_sha256", "expected_action_class"]);
    const reference = request.args.ref;
    const text = request.args.text;
    const textSha256 = request.args.text_sha256;
    if (
      typeof reference !== "string"
      || reference.length === 0
      || reference.length > 128
      || typeof text !== "string"
      || text.length === 0
      || hasUnpairedSurrogate(text)
      || text.includes("\u0000")
      || text.includes("\r")
      || new TextEncoder().encode(text).byteLength > 32_768
      || typeof textSha256 !== "string"
      || !/^[0-9a-f]{64}$/u.test(textSha256)
      || request.args.expected_action_class !== "sensitive_input"
    ) throw new NativeRequestError("Type requires exact bounded sensitive text and a semantic ref.", "INVALID_STATE");
    request = {
      ...request,
      args: Object.freeze({
        ref: reference,
        text,
        text_sha256: textSha256,
        expected_action_class: "sensitive_input",
      }),
    };
    if (await sha256(text) !== textSha256) {
      throw new NativeRequestError("The supplied text digest does not match the exact UTF-8 input.", "INVALID_STATE");
    }
    if (request.policy.actionGrantId !== null) {
      throw new NativeRequestError("Opaque type preauthorization is not independently verifiable.", "APPROVAL_REQUIRED");
    }
    const hasLineFeed = text.includes("\n");
    const dataClassification = {
      kind: "text",
      sensitivity: "sensitive",
      textSha256,
    } as const;
    let lease = leaseForRequest(this.store.snapshot, request);
    await this.exactLeasedTab(lease);
    lease = await this.bindContentLease(lease, request);
    this.assertNotCanceled(request);
    lease = this.refreshExactOperationLease(request, lease);
    if (lease.debuggerAttached) {
      throw new NativeRequestError("The exact lease has unresolved debugger cleanup debt.", "OUTCOME_UNKNOWN", "unknown");
    }
    const mutation = await this.prepareLeasedMutation(request, "type");
    if (mutation.disposition === "replay_applied") {
      return {
        lease_id: lease.leaseId,
        browser_id: lease.tabHandle,
        tab_handle: lease.tabHandle,
        document_epoch: String(lease.identity.documentEpoch),
        ref: reference,
        action_class: "sensitive_input",
      };
    }

    let stage: "prepared" | "waiting_approval" | "effect_started" | "terminal" = "prepared";
    let debuggerBinding: DebuggerLeaseBinding | null = null;
    let effectStarted = false;
    try {
      this.assertOperationAuthority(request);
      this.assertNotCanceled(request);
      lease = this.refreshExactOperationLease(request, lease);
      await this.exactLeasedTab(lease);
      this.assertOperationAuthority(request);
      const prepared = await this.contentHost.command(lease, {
        commandId: `type-target:${request.actionId}`,
        operationId: request.opId,
        actionId: request.actionId,
        deadlineAtMs: request.deadlineAtMs,
        assertAuthority: () => this.assertOperationAuthority(request),
        command: { name: "target.prepare_type", element_ref: reference, has_line_feed: hasLineFeed },
      });
      const initial = this.parseTypeTarget(prepared.result);
      lease = this.refreshExactOperationLease(request, lease);
      if (!lease.overlayAttached) {
        lease = { ...lease, overlayAttached: true, revision: lease.revision + 1 };
        await this.persistLease(lease);
      }

      const settlement = await this.awaitActionChallenge(
        request,
        lease,
        "sensitive_input",
        initial.targetFingerprint,
        mutation.canonicalParameterHash,
        dataClassification,
        "Allow Agent Zero to type into the highlighted field?",
      );
      stage = "waiting_approval";
      if (settlement.code || settlement.decision !== "approve_once" || !settlement.grant) {
        throw new NativeRequestError(
          settlement.code === "CHALLENGE_EXPIRED"
            ? "The action challenge expired before approval."
            : settlement.code === "CANCELED"
              ? "The action challenge was canceled before approval."
              : "The typing action was declined by Agent Zero.",
          settlement.code || "APPROVAL_DENIED",
        );
      }
      if (Date.now() >= settlement.grant.expiresAtMs) {
        throw new NativeRequestError("The exact type grant expired before input dispatch.", "CHALLENGE_EXPIRED");
      }

      this.assertOperationAuthority(request);
      this.assertNotCanceled(request);
      lease = this.refreshExactOperationLease(request, lease);
      await this.exactLeasedTab(lease);
      lease = { ...lease, debuggerAttached: true, revision: lease.revision + 1 };
      await this.persistLease(lease);
      debuggerBinding = debuggerBindingForLease(lease, request.actionId);
      this.assertOperationAuthority(request);
      await this.debuggerHost.attach(debuggerBinding);

      this.assertOperationAuthority(request);
      this.assertNotCanceled(request);
      lease = this.refreshExactOperationLease(request, lease);
      await this.exactLeasedTab(lease);
      const resolved = await this.revalidateTypeTarget(
        request,
        lease,
        reference,
        initial.targetFingerprint,
        hasLineFeed,
      );
      this.assertOperationAuthority(request);
      const backendNodeId = await this.debuggerHost.resolveBackendNodeAtPoint(debuggerBinding, resolved);

      this.assertOperationAuthority(request);
      this.assertNotCanceled(request);
      lease = this.refreshExactOperationLease(request, lease);
      await this.exactLeasedTab(lease);
      await this.revalidateTypeTarget(request, lease, reference, initial.targetFingerprint, hasLineFeed);
      if (Date.now() >= settlement.grant.expiresAtMs) {
        throw new NativeRequestError("The exact type grant expired before focus.", "CHALLENGE_EXPIRED");
      }
      await this.transitionMutationRecord(request.actionId, "waiting_approval", "effect_started");
      stage = "effect_started";
      effectStarted = true;
      this.markEffectInvoked(request);
      this.assertOperationAuthority(request);
      await this.debuggerHost.focusBackendNode(debuggerBinding, backendNodeId);

      this.assertOperationAuthority(request);
      this.assertNotCanceled(request);
      lease = this.refreshExactOperationLease(request, lease);
      this.assertOperationAuthority(request);
      const focused = await this.contentHost.command(lease, {
        commandId: `type-focus:${request.actionId}:${crypto.randomUUID()}`,
        operationId: request.opId,
        actionId: request.actionId,
        deadlineAtMs: request.deadlineAtMs,
        assertAuthority: () => this.assertOperationAuthority(request),
        command: {
          name: "target.confirm_type_focus",
          element_ref: reference,
          target_fingerprint: initial.targetFingerprint,
          has_line_feed: hasLineFeed,
        },
      });
      if (focused.result?.state !== "type_focus_ready") {
        throw new NativeRequestError("Chrome did not focus the exact approved empty type target.", "OUTCOME_UNKNOWN", "unknown");
      }

      this.assertOperationAuthority(request);
      this.assertNotCanceled(request);
      lease = this.refreshExactOperationLease(request, lease);
      if (Date.now() >= settlement.grant.expiresAtMs) {
        throw new NativeRequestError("The exact type grant expired before text insertion.", "CHALLENGE_EXPIRED");
      }
      this.assertOperationAuthority(request);
      await this.debuggerHost.insertText(debuggerBinding, text);

      this.assertOperationAuthority(request);
      this.assertNotCanceled(request);
      lease = this.refreshExactOperationLease(request, lease);
      this.assertOperationAuthority(request);
      const verified = await this.contentHost.command(lease, {
        commandId: `type-verify:${request.actionId}:${crypto.randomUUID()}`,
        operationId: request.opId,
        actionId: request.actionId,
        deadlineAtMs: request.deadlineAtMs,
        assertAuthority: () => this.assertOperationAuthority(request),
        command: {
          name: "target.verify_type_value",
          element_ref: reference,
          target_fingerprint: initial.targetFingerprint,
          text_sha256: textSha256,
          has_line_feed: hasLineFeed,
        },
      });
      if (verified.result?.state !== "type_verified") {
        throw new NativeRequestError("The exact text digest could not be verified after input.", "OUTCOME_UNKNOWN", "unknown");
      }
      this.assertOperationAuthority(request);
      const activated = await this.contentHost.command(lease, {
        commandId: `type-activate:${request.actionId}`,
        operationId: request.opId,
        actionId: request.actionId,
        deadlineAtMs: request.deadlineAtMs,
        assertAuthority: () => this.assertOperationAuthority(request),
        command: { name: "cursor.activate" },
      });
      if (activated.result?.state !== "activated") {
        throw new NativeRequestError("The illuminated cursor did not confirm type activation.", "OUTCOME_UNKNOWN", "unknown");
      }

      const detached = await this.debuggerHost.detach(debuggerBinding);
      if (!detached) {
        throw new NativeRequestError("Chrome did not confirm debugger cleanup after type.", "OUTCOME_UNKNOWN", "unknown");
      }
      const detachedBinding = debuggerBinding;
      debuggerBinding = null;
      const detachedLease = this.currentDebuggerLease(detachedBinding);
      if (!detachedLease) {
        throw new NativeRequestError("The lease identity changed during type cleanup.", "TAB_IDENTITY_MISMATCH", "unknown");
      }
      lease = { ...detachedLease, debuggerAttached: false, revision: detachedLease.revision + 1 };
      await this.persistLease(lease);
      await this.transitionMutationRecord(request.actionId, "effect_started", "succeeded", {
        outcome: "applied",
        code: null,
        leaseHandleDigest: await sha256(lease.tabHandle),
      });
      stage = "terminal";
      return {
        lease_id: lease.leaseId,
        browser_id: lease.tabHandle,
        tab_handle: lease.tabHandle,
        document_epoch: String(lease.identity.documentEpoch),
        ref: reference,
        action_class: "sensitive_input",
      };
    } catch (error) {
      if (debuggerBinding) {
        const detached = await this.debuggerHost.detach(debuggerBinding);
        if (detached) {
          const current = this.currentDebuggerLease(debuggerBinding);
          if (current?.debuggerAttached) {
            await this.persistLease({ ...current, debuggerAttached: false, revision: current.revision + 1 });
          }
        }
      }
      const live = this.liveOperations.get(request.actionId);
      if (live) await this.cancelOperationCursor(live, `type-failure-${request.actionId}`);
      if (stage !== "terminal") {
        const currentOperation = this.store.snapshot.ledger.operations.find((record) =>
          record.loadGenerationId === this.store.snapshot.lifecycle.loadGenerationId
          && record.actionId === request.actionId,
        );
        if (currentOperation && !["succeeded", "failed", "canceled", "outcome_unknown"].includes(currentOperation.stage)) {
          const currentStage = currentOperation.stage;
          try {
            await this.transitionMutationRecord(
              request.actionId,
              currentStage,
              currentStage === "effect_started" ? "outcome_unknown" : "failed",
              {
                outcome: currentStage === "effect_started" ? "unknown" : "not_applied",
                code: currentStage === "effect_started"
                  ? "OUTCOME_UNKNOWN"
                  : error instanceof NativeRequestError ? error.a0Code : "INTERNAL_ERROR",
                leaseHandleDigest: await sha256(lease.tabHandle),
              },
            );
            stage = "terminal";
          } catch {
            // A failed terminal write cannot make trusted text input safe to replay.
          }
        }
      }
      if (error instanceof NativeRequestError) {
        if (effectStarted && error.outcome === "not_applied") {
          throw new NativeRequestError(error.message, "OUTCOME_UNKNOWN", "unknown");
        }
        throw error;
      }
      throw new NativeRequestError(
        effectStarted ? "The type outcome is unknown." : "The type operation failed before page input.",
        effectStarted ? "OUTCOME_UNKNOWN" : "INTERNAL_ERROR",
        effectStarted ? "unknown" : "not_applied",
      );
    }
  }

  private parseTypeTarget(result: Record<string, unknown> | undefined): {
    x: number;
    y: number;
    targetFingerprint: string;
  } {
    if (
      result?.state !== "type_ready"
      || !Number.isSafeInteger(result.x)
      || !Number.isSafeInteger(result.y)
      || Number(result.x) < 0
      || Number(result.y) < 0
      || Number(result.x) > 100_000
      || Number(result.y) > 100_000
      || result.action_class !== "sensitive_input"
      || typeof result.target_fingerprint !== "string"
      || !/^[0-9a-f]{64}$/u.test(result.target_fingerprint)
    ) throw new NativeRequestError("The page runtime did not return an exact semantic type target.", "INVALID_STATE");
    return {
      x: Number(result.x),
      y: Number(result.y),
      targetFingerprint: result.target_fingerprint,
    };
  }

  private async revalidateTypeTarget(
    request: ScopedBrowserPerformRequest,
    lease: TabLease,
    reference: string,
    targetFingerprint: string,
    hasLineFeed: boolean,
  ): Promise<{ x: number; y: number }> {
    this.assertOperationAuthority(request);
    const response = await this.contentHost.command(lease, {
      commandId: `type-revalidate:${request.actionId}:${crypto.randomUUID()}`,
      operationId: request.opId,
      actionId: request.actionId,
      deadlineAtMs: request.deadlineAtMs,
      assertAuthority: () => this.assertOperationAuthority(request),
      command: {
        name: "target.revalidate_type",
        element_ref: reference,
        target_fingerprint: targetFingerprint,
        has_line_feed: hasLineFeed,
      },
    });
    const current = this.parseTypeTarget(response.result);
    if (current.targetFingerprint !== targetFingerprint) {
      throw new NativeRequestError("The semantic type target changed before trusted input.", "DOCUMENT_MISMATCH");
    }
    return { x: current.x, y: current.y };
  }

  private effectiveClickClass(
    expected: "reversible_input" | "sensitive_input" | "external_side_effect" | "unknown",
    local: "reversible_input" | ConsequentialActionClass,
  ): "reversible_input" | ConsequentialActionClass {
    if (expected === "unknown" || local === "unknown") return "unknown";
    if (expected === "external_side_effect" || local === "external_side_effect") return "external_side_effect";
    if (expected === "sensitive_input" || local === "sensitive_input") return "sensitive_input";
    return "reversible_input";
  }

  private async revalidateClickTarget(
    request: ScopedBrowserPerformRequest,
    lease: TabLease,
    reference: string,
    targetFingerprint: string,
    localClass: "reversible_input" | ConsequentialActionClass,
    upload = false,
  ): Promise<{ x: number; y: number }> {
    this.assertOperationAuthority(request);
    const response = await this.contentHost.command(lease, {
      commandId: `click-revalidate:${request.actionId}:${crypto.randomUUID()}`,
      operationId: request.opId,
      actionId: request.actionId,
      deadlineAtMs: request.deadlineAtMs,
      assertAuthority: () => this.assertOperationAuthority(request),
      command: {
        name: upload ? "target.revalidate_upload" : "target.revalidate_click",
        element_ref: reference,
        target_fingerprint: targetFingerprint,
      },
    });
    const current = this.parseClickTarget(response.result);
    if (current.targetFingerprint !== targetFingerprint || current.actionClass !== localClass) {
      throw new NativeRequestError("The semantic click target changed before trusted input.", "DOCUMENT_MISMATCH");
    }
    return { x: current.x, y: current.y };
  }

  private decodeScreenshot(encoded: string): Uint8Array {
    const canonical = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
    if (!encoded || !canonical.test(encoded) || encoded.length > Math.ceil(MAX_OUTPUT_ARTIFACT_BYTES / 3) * 4 + 4) {
      throw new NativeRequestError("Chrome returned an invalid or oversized screenshot.", "ARTIFACT_TOO_LARGE");
    }
    let binary: string;
    try {
      binary = atob(encoded);
    } catch {
      throw new NativeRequestError("Chrome returned malformed screenshot bytes.", "OUTCOME_UNKNOWN", "unknown");
    }
    if (binary.length < 1 || binary.length > MAX_OUTPUT_ARTIFACT_BYTES) {
      throw new NativeRequestError("The screenshot exceeds the artifact size limit.", "ARTIFACT_TOO_LARGE");
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  private refreshExactOperationLease(
    request: ScopedBrowserPerformRequest,
    expected: TabLease,
  ): TabLease {
    const current = this.refreshExactLease(request, expected, true);
    if (
      current.identity.providerTabId !== expected.identity.providerTabId
      || current.identity.providerWindowId !== expected.identity.providerWindowId
      || current.siteOrigin !== expected.siteOrigin
    ) throw new NativeRequestError("The exact browser operation tab identity changed.", "TAB_IDENTITY_MISMATCH", "unknown");
    return current;
  }

  private currentDebuggerLease(binding: DebuggerLeaseBinding): TabLease | null {
    const current = this.store.snapshot.session.leasesByHandle[binding.tabHandle];
    if (
      !current
      || current.leaseId !== binding.leaseId
      || current.identity.providerTabId !== binding.providerTabId
      || !current.debuggerAttached
    ) return null;
    return current;
  }

  private async sha256Bytes(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  private encodeArtifactChunk(bytes: Uint8Array): string {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
    return btoa(binary);
  }

  private artifactTimeout(request: ScopedBrowserPerformRequest): number {
    const remaining = request.deadlineAtMs - Date.now();
    if (remaining < 1) throw new NativeRequestError("The screenshot artifact deadline expired.", "DEADLINE_EXCEEDED");
    return Math.min(remaining, 120_000);
  }

  private currentNegotiation() {
    const stored = this.store.snapshot.session.connection;
    const current = this.currentConnection();
    const features: string[] = BROWSER_RUNTIME_CAPABILITIES.filter((feature) =>
      current.negotiatedFeatures?.includes(feature) && stored.negotiatedFeatures?.includes(feature),
    );
    const actions = negotiatedActions(
      (current.negotiatedActions ?? []).filter((action) => stored.negotiatedActions?.includes(action)), features,
    );
    return { current, actions, features };
  }

  private currentOperationAuthority(request: BrowserPerformRequest): OperationAuthority {
    const snapshot = this.store.snapshot;
    const connection = snapshot.session.connection;
    const { current, actions, features } = this.currentNegotiation();
    const live = request.actionId === null ? undefined : this.liveOperations.get(request.actionId);
    const outcome = live?.effectInvoked ? "unknown" : "not_applied";
    if (
      snapshot.lifecycle.phase !== "READY"
      || connection.state !== "ready"
      || !browserConnectionAuthorityKey(connection, snapshot.lifecycle)
      || !connection.connectionId
      || current.state !== "ready"
      || !browserConnectionAuthorityKey(current, snapshot.lifecycle)
      || browserConnectionAuthorityKey(current, snapshot.lifecycle) !== browserConnectionAuthorityKey(connection, snapshot.lifecycle)
      || current.connectionId !== connection.connectionId
    ) throw new NativeRequestError("The browser operation authority is unavailable.", "CONNECTION_LOST", outcome, true);
    const requiresCursor = request.display.cursor
      || (request.action === "screenshot" && request.target !== null
        && Boolean(snapshot.session.leasesByHandle[request.target.tabHandle]?.identity.documentId));
    const required = new Set([
      ...request.requiredCapabilities,
      ...(ACTION_FEATURES[request.action] ?? []),
      ...(requiresCursor ? ["cursor_v1"] : []),
    ]);
    const missing = [...required].filter((capability) =>
      !supportedCapabilities.has(capability)
      || !(implementedActions.has(capability) ? actions : features).includes(capability),
    );
    if (!actions.includes(request.action) || missing.length) {
      throw new NativeRequestError("The browser action or required capability was not negotiated.", "UNSUPPORTED_CAPABILITY", outcome, false, { missing });
    }
    return {
      admissionIdentity: browserConnectionAuthorityKey(current, snapshot.lifecycle)!,
      connectionId: connection.connectionId,
      installInstanceId: snapshot.lifecycle.installInstanceId,
      loadGenerationId: snapshot.lifecycle.loadGenerationId,
      workerBootId: snapshot.lifecycle.workerBootId,
      browserInstanceId: snapshot.session.browserInstanceId,
    };
  }

  private assertCapturedAuthority(request: ScopedBrowserPerformRequest): void {
    const current = this.currentOperationAuthority(request);
    const live = this.liveOperations.get(request.actionId);
    if (
      !live
      || live.request.opId !== request.opId
      || Object.keys(current).some((key) => current[key as keyof OperationAuthority] !== live.authority[key as keyof OperationAuthority])
    ) throw new NativeRequestError("The browser operation connection or generation changed.", "CONNECTION_LOST", live?.effectInvoked ? "unknown" : "not_applied", true);
  }

  private assertOperationAuthority(request: ScopedBrowserPerformRequest): void {
    this.assertCapturedAuthority(request);
    this.assertTurnAcceptsOperations(request);
  }

  private assertTransferAck(
    ack: ArtifactAck,
    expectedChunkIndex: number,
    expectedReceivedBytes: number,
  ): void {
    if (ack.status === "aborted") {
      throw new NativeRequestError("The server aborted the screenshot artifact.", ack.reasonCode, "not_applied");
    }
    if (
      (ack.phase !== "begin" && ack.phase !== "chunk")
      || ack.nextChunkIndex !== expectedChunkIndex
      || ack.receivedBytes !== expectedReceivedBytes
    ) throw new NativeRequestError("The artifact acknowledgement did not match the exact stream position.", "OUTCOME_UNKNOWN", "unknown");
  }

  private async streamArtifact(
    pending: PendingOutputArtifact,
    bytes: Uint8Array,
    descriptor: ArtifactDescriptor,
  ): Promise<void> {
    const { request, binding, controller } = pending;
    this.assertOperationAuthority(request);
    this.assertNotCanceled(request);
    pending.beginSent = true;
    const begin = await this.artifactTransport.artifactBegin(binding, {
      mimeType: descriptor.mime_type,
      byteCount: descriptor.byte_count,
      sha256: descriptor.sha256,
    }, { timeoutMs: this.artifactTimeout(request), signal: controller.signal });
    this.assertTransferAck(begin, 0, 0);

    let chunkIndex = 0;
    let receivedBytes = 0;
    for (let offset = 0; offset < bytes.length; offset += MAX_OUTPUT_ARTIFACT_CHUNK_BYTES) {
      this.assertOperationAuthority(request);
      this.assertNotCanceled(request);
      const chunk = bytes.subarray(offset, Math.min(offset + MAX_OUTPUT_ARTIFACT_CHUNK_BYTES, bytes.length));
      const ack = await this.artifactTransport.artifactChunk(
        binding,
        chunkIndex,
        this.encodeArtifactChunk(chunk),
        { timeoutMs: this.artifactTimeout(request), signal: controller.signal },
      );
      receivedBytes += chunk.byteLength;
      chunkIndex += 1;
      this.assertTransferAck(ack, chunkIndex, receivedBytes);
    }

    this.assertOperationAuthority(request);
    this.assertNotCanceled(request);
    const end = await this.artifactTransport.artifactEnd(
      binding,
      { timeoutMs: this.artifactTimeout(request), signal: controller.signal },
    );
    if (end.status === "aborted") {
      throw new NativeRequestError("The server aborted the completed screenshot artifact.", end.reasonCode, "unknown");
    }
    if (
      end.phase !== "end"
      || end.descriptor.artifact_id !== descriptor.artifact_id
      || end.descriptor.mime_type !== descriptor.mime_type
      || end.descriptor.byte_count !== descriptor.byte_count
      || end.descriptor.sha256 !== descriptor.sha256
      || end.descriptor.purpose !== descriptor.purpose
    ) throw new NativeRequestError("The completed artifact descriptor did not match the captured screenshot.", "OUTCOME_UNKNOWN", "unknown");
  }

  private artifactAbortReason(error: unknown): ArtifactAbortReason {
    const code = error instanceof NativeRequestError ? error.a0Code : error instanceof Error ? error.name : "";
    if (code === "ARTIFACT_TOO_LARGE") return "ARTIFACT_TOO_LARGE";
    if (code === "CANCELED" || code === "NativeRequestCancelledError") return "CANCELED";
    if (code === "DEADLINE_EXCEEDED" || code === "NativeRequestTimeoutError") return "DEADLINE_EXCEEDED";
    if (code === "CONNECTION_LOST" || code === "NativeConnectionError" || code === "NativeRpcError") return "CONNECTION_LOST";
    if (error instanceof NativeRequestError && error.outcome === "unknown") return "OUTCOME_UNKNOWN";
    return "INTERNAL_ERROR";
  }

  private async abortPendingArtifact(
    pending: PendingOutputArtifact,
    reasonCode: ArtifactAbortReason,
    failureCode: PendingOutputArtifact["failureCode"] = null,
  ): Promise<void> {
    if (failureCode && !pending.failureCode) pending.failureCode = failureCode;
    pending.controller.abort();
    if (!pending.beginSent || pending.completed || pending.abortSent) return;
    pending.abortSent = true;
    try {
      await this.artifactTransport.artifactAbort(pending.binding, reasonCode, { timeoutMs: 5_000 });
    } catch {
      // The receiver retains its exact pending binding. Reconnect/reconcile owns
      // remote cleanup; captured bytes are never retained locally.
    }
  }

  private async cancelPendingArtifactForOperation(
    request: ScopedBrowserPerformRequest,
    reasonCode: ArtifactAbortReason,
  ): Promise<void> {
    const pending = this.pendingArtifacts.get(request.actionId);
    if (
      !pending
      || pending.request.opId !== request.opId
      || pending.request.contextId !== request.contextId
      || pending.request.browserSessionId !== request.browserSessionId
      || pending.request.turnId !== request.turnId
    ) return;
    await this.abortPendingArtifact(
      pending,
      reasonCode,
      reasonCode === "CONNECTION_LOST" ? "CONNECTION_LOST" : "CANCELED",
    );
  }

  private async content(request: ScopedBrowserPerformRequest): Promise<Record<string, unknown>> {
    requireOriginGrant(request);
    exactActionArgs(request.args, [], ["max_nodes", "max_text_chars"]);
    const maxNodes = boundedOptionalInteger(request.args.max_nodes, 128, "max_nodes");
    const maxTextChars = boundedOptionalInteger(request.args.max_text_chars, 24_000, "max_text_chars");
    let lease = leaseForRequest(this.store.snapshot, request);
    await this.exactLeasedTab(lease);
    this.assertNotCanceled(request);
    lease = await this.bindContentLease(lease, request);
    this.assertNotCanceled(request);
    lease = this.refreshExactLease(request, lease, true);
    if (!lease.identity.documentId) {
      throw new NativeRequestError("Semantic content requires an exact bound document.", "DOCUMENT_MISMATCH");
    }
    assertBeforeDeadline(request);
    this.assertOperationAuthority(request);
    const response = await this.contentHost.command(lease, {
      commandId: `content:${request.actionId}`,
      operationId: request.opId,
      actionId: request.actionId,
      deadlineAtMs: request.deadlineAtMs,
      assertAuthority: () => this.assertOperationAuthority(request),
      command: {
        name: "semantics.inspect",
        ...(maxNodes === undefined ? {} : { max_nodes: maxNodes }),
        ...(maxTextChars === undefined ? {} : { max_text_chars: maxTextChars }),
      },
    });
    if (response.result?.state !== "inspected") {
      throw new NativeRequestError("The page runtime did not return semantic content.", "INTERNAL_ERROR");
    }
    lease = this.refreshExactLease(request, lease, true);
    return {
      lease_id: lease.leaseId,
      browser_id: lease.tabHandle,
      tab_handle: lease.tabHandle,
      document_id: lease.identity.documentId,
      document_epoch: String(lease.identity.documentEpoch),
      ...response.result.snapshot,
    };
  }

  private async navigate(request: ScopedBrowserPerformRequest): Promise<Record<string, unknown>> {
    requireOriginGrant(request);
    exactActionArgs(request.args, ["url"]);
    const destination = exactHttpUrl(request.args.url);
    let lease = leaseForRequest(this.store.snapshot, request);
    await this.exactLeasedTab(lease);
    const mutation = await this.prepareLeasedMutation(request, "navigate");
    if (mutation.disposition === "replay_applied") {
      return {
        lease_id: lease.leaseId,
        browser_id: lease.tabHandle,
        tab_handle: lease.tabHandle,
        origin: destination.origin,
      };
    }
    const crossOrigin = destination.origin !== lease.siteOrigin;
    let expectedStage: DurableMutationStage = "prepared";
    if (crossOrigin) {
      const settlement = await this.awaitSiteChallenge(
        request,
        lease,
        destination,
        mutation.canonicalParameterHash,
      );
      if (settlement.code || !settlement.grant || settlement.decision === "deny") {
        throw new NativeRequestError(
          settlement.code === "CHALLENGE_EXPIRED"
            ? "The site challenge expired before approval."
            : settlement.code === "CANCELED"
              ? "The site challenge was canceled before approval."
              : "The site challenge was denied by Agent Zero.",
          settlement.code || "APPROVAL_DENIED",
        );
      }
      expectedStage = "waiting_approval";
    }
    try {
      this.assertNotCanceled(request);
      lease = this.refreshExactLease(request, lease, false);
      await this.exactLeasedTab(lease);
      this.assertNotCanceled(request);
      await this.contentHost.release(lease, "navigation");
      this.assertNotCanceled(request);
      lease = this.refreshExactLease(request, lease, false);
      await this.exactLeasedTab(lease);
      this.assertNotCanceled(request);
      if (crossOrigin) this.assertChallengeTransportAuthority(request);
      assertBeforeDeadline(request);
    } catch (error) {
      if (crossOrigin) await this.terminalizeWaitingChallenge(request, error);
      if (error instanceof NativeRequestError) throw error;
      throw new NativeRequestError("The navigation deadline expired before its effect.", "DEADLINE_EXCEEDED", "not_applied", true);
    }
    await this.transitionMutationRecord(request.actionId, expectedStage, "effect_started");
    let approvedNavigation: ApprovedNavigation;
    try {
      lease = this.refreshExactLease(request, lease, false);
      await this.exactLeasedTab(lease);
      if (crossOrigin) this.assertChallengeTransportAuthority(request);
      approvedNavigation = {
        actionId: request.actionId,
        leaseId: lease.leaseId,
        tabHandle: lease.tabHandle,
        sourceOrigin: lease.siteOrigin,
        destinationOrigin: destination.origin,
        destinationHref: destination.href,
        documentId: lease.identity.documentId,
        documentEpoch: lease.identity.documentEpoch,
      };
      this.approvedNavigations.set(lease.identity.providerTabId, approvedNavigation);
      this.markEffectInvoked(request);
    } catch (error) {
      await this.transitionMutationRecord(request.actionId, "effect_started", "failed", {
        outcome: "not_applied",
        code: error instanceof NativeRequestError ? error.a0Code : "CANCELED",
        leaseHandleDigest: await sha256(lease.tabHandle),
      });
      throw error;
    }
    try {
      await chrome.tabs.update(lease.identity.providerTabId, { url: destination.href });
    } catch {
      this.approvedNavigations.delete(lease.identity.providerTabId);
      await this.transitionMutationRecord(request.actionId, "effect_started", "outcome_unknown", {
        outcome: "unknown",
        code: "OUTCOME_UNKNOWN",
        leaseHandleDigest: await sha256(lease.tabHandle),
      });
      throw new NativeRequestError("Chrome did not return a certain navigation outcome.", "OUTCOME_UNKNOWN", "unknown");
    }

    try {
      const navigated = await this.exactNavigatedTab(lease, destination.origin);
      const current = this.currentMatchingLease(lease);
      if (!current || current.state !== "active") {
        throw new NativeRequestError("The leased tab identity changed during navigation.", "TAB_IDENTITY_MISMATCH", "unknown");
      }
      if (current.siteOrigin !== destination.origin && current.siteOrigin !== approvedNavigation.sourceOrigin) {
        throw new NativeRequestError("The leased tab reached an unexpected origin.", "ORIGIN_BLOCKED", "unknown");
      }
      lease = current.siteOrigin === destination.origin
        ? current
        : {
            ...current,
            siteOrigin: destination.origin,
            identity: {
              ...current.identity,
              documentId: null,
              documentEpoch: current.identity.documentEpoch + 1,
            },
            overlayAttached: false,
            revision: current.revision + 1,
          };
      await this.persistLease(lease, navigated.url?.toString() || destination.href);
      this.approvedNavigations.delete(lease.identity.providerTabId);
      await this.transitionMutationRecord(request.actionId, "effect_started", "succeeded", {
        outcome: "applied",
        code: null,
        leaseHandleDigest: await sha256(lease.tabHandle),
      });
    } catch {
      this.approvedNavigations.delete(lease.identity.providerTabId);
      try {
        await this.transitionMutationRecord(request.actionId, "effect_started", "outcome_unknown", {
          outcome: "unknown",
          code: "OUTCOME_UNKNOWN",
          leaseHandleDigest: await sha256(lease.tabHandle),
        });
      } catch {
        // The caller still receives unknown; a failed recovery write cannot make it safe to replay.
      }
      throw new NativeRequestError("The navigation outcome could not be persisted.", "OUTCOME_UNKNOWN", "unknown");
    }
    return {
      lease_id: lease.leaseId,
      browser_id: lease.tabHandle,
      tab_handle: lease.tabHandle,
      origin: destination.origin,
    };
  }

  private async scroll(request: ScopedBrowserPerformRequest): Promise<Record<string, unknown>> {
    requireOriginGrant(request);
    exactActionArgs(request.args, ["ref"]);
    if (typeof request.args.ref !== "string" || request.args.ref.length === 0 || request.args.ref.length > 128) {
      throw new NativeRequestError("Scroll requires a bounded opaque element reference.", "INVALID_STATE");
    }
    let lease = leaseForRequest(this.store.snapshot, request);
    await this.exactLeasedTab(lease);
    lease = await this.bindContentLease(lease, request);
    this.assertNotCanceled(request);
    const mutation = await this.prepareLeasedMutation(request, "scroll");
    if (mutation.disposition === "replay_applied") {
      return {
        lease_id: lease.leaseId,
        browser_id: lease.tabHandle,
        tab_handle: lease.tabHandle,
        ref: request.args.ref,
      };
    }
    this.assertNotCanceled(request);
    lease = this.refreshExactLease(request, lease, true);
    await this.transitionMutationRecord(request.actionId, "prepared", "effect_started");
    lease = this.refreshExactLease(request, lease, true);
    assertBeforeDeadline(request);
    this.markEffectInvoked(request);
    let effectConfirmed = false;
    try {
      this.assertOperationAuthority(request);
      const response = await this.contentHost.command(lease, {
        commandId: `scroll:${request.actionId}`,
        operationId: request.opId,
        actionId: request.actionId,
        deadlineAtMs: request.deadlineAtMs,
        assertAuthority: () => this.assertOperationAuthority(request),
        command: {
          name: "page.scroll_to_ref",
          element_ref: request.args.ref,
          show_cursor: request.display.cursor,
        },
      });
      if (response.result?.state !== "scrolled") {
        throw new NativeRequestError("The page runtime did not confirm the scroll.", "INTERNAL_ERROR");
      }
      effectConfirmed = true;
      lease = this.refreshExactLease(request, lease, true);
      const live = this.liveOperations.get(request.actionId);
      if (live?.cancelRequested) {
        await this.cancelOperationCursor(live, `late-${request.actionId}`);
        lease = this.refreshExactLease(request, lease, true);
      } else if (request.display.cursor && !lease.overlayAttached) {
        lease = { ...lease, overlayAttached: true, revision: lease.revision + 1 };
        await this.persistLease(lease);
      }
      await this.transitionMutationRecord(request.actionId, "effect_started", "succeeded", {
        outcome: "applied",
        code: null,
        leaseHandleDigest: await sha256(lease.tabHandle),
      });
      return {
        lease_id: lease.leaseId,
        browser_id: lease.tabHandle,
        tab_handle: lease.tabHandle,
        ref: request.args.ref,
        ...(response.result.x === undefined ? {} : { x: response.result.x }),
        ...(response.result.y === undefined ? {} : { y: response.result.y }),
      };
    } catch (error) {
      const knownNotApplied = !effectConfirmed && error instanceof NativeRequestError && error.outcome === "not_applied";
      try {
        await this.transitionMutationRecord(
          request.actionId,
          "effect_started",
          knownNotApplied ? "failed" : "outcome_unknown",
          {
            outcome: knownNotApplied ? "not_applied" : "unknown",
            code: knownNotApplied ? error.a0Code : "OUTCOME_UNKNOWN",
            leaseHandleDigest: await sha256(lease.tabHandle),
          },
        );
      } catch {
        // Preserve the safer caller-visible outcome even if the recovery write is unavailable.
      }
      if (knownNotApplied) throw error;
      throw new NativeRequestError("The page scroll outcome is unknown.", "OUTCOME_UNKNOWN", "unknown");
    }
  }

  private async exactLeasedTab(lease: TabLease): Promise<{ tab: chrome.tabs.Tab; url: URL }> {
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(lease.identity.providerTabId);
    } catch {
      throw new NativeRequestError("The leased tab no longer exists.", "TAB_NOT_FOUND");
    }
    if (tab.id !== lease.identity.providerTabId || tab.windowId !== lease.identity.providerWindowId || tab.incognito) {
      throw new NativeRequestError("The leased tab identity changed.", "TAB_IDENTITY_MISMATCH");
    }
    let url: URL;
    try {
      url = exactHttpUrl(tab.url);
    } catch {
      throw new NativeRequestError("The leased tab is no longer an HTTP(S) page.", "CHROME_RESTRICTED_URL");
    }
    if (url.origin !== lease.siteOrigin) {
      throw new NativeRequestError("The leased tab left its authorized origin.", "ORIGIN_BLOCKED");
    }
    return { tab, url };
  }

  private async exactNavigatedTab(lease: TabLease, expectedOrigin: string): Promise<{ tab: chrome.tabs.Tab; url: URL }> {
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(lease.identity.providerTabId);
    } catch {
      throw new NativeRequestError("The navigated tab no longer exists.", "TAB_NOT_FOUND", "unknown");
    }
    if (tab.id !== lease.identity.providerTabId || tab.windowId !== lease.identity.providerWindowId || tab.incognito) {
      throw new NativeRequestError("The navigated tab identity changed.", "TAB_IDENTITY_MISMATCH", "unknown");
    }
    let url: URL;
    try {
      url = exactHttpUrl(tab.url);
    } catch {
      throw new NativeRequestError("The navigated tab reached a restricted page.", "CHROME_RESTRICTED_URL", "unknown");
    }
    if (url.origin !== expectedOrigin) {
      throw new NativeRequestError("The navigated tab reached an unexpected origin.", "ORIGIN_BLOCKED", "unknown");
    }
    return { tab, url };
  }

  private refreshExactLease(
    request: ScopedBrowserPerformRequest,
    expected: TabLease,
    requireSameDocument: boolean,
  ): TabLease {
    this.assertOperationAuthority(request);
    const current = leaseForRequest(this.store.snapshot, request);
    if (current.leaseId !== expected.leaseId) {
      throw new NativeRequestError("The tab lease identity changed.", "LEASE_CONFLICT");
    }
    if (
      requireSameDocument
      && (
        current.identity.documentId !== expected.identity.documentId
        || current.identity.documentEpoch !== expected.identity.documentEpoch
      )
    ) {
      throw new NativeRequestError("The page document changed.", "ELEMENT_REFERENCE_STALE");
    }
    return current;
  }

  private currentMatchingLease(expected: TabLease): TabLease | null {
    const current = this.store.snapshot.session.leasesByHandle[expected.tabHandle];
    if (
      !current
      || current.leaseId !== expected.leaseId
      || current.loadGenerationId !== expected.loadGenerationId
      || current.contextId !== expected.contextId
      || current.browserSessionId !== expected.browserSessionId
      || current.turnId !== expected.turnId
    ) {
      return null;
    }
    return current;
  }

  private async bindContentLease(lease: TabLease, request: ScopedBrowserPerformRequest): Promise<TabLease> {
    this.assertOperationAuthority(request);
    const bound = await this.contentHost.bind(lease, () => this.assertOperationAuthority(request));
    this.assertOperationAuthority(request);
    if (
      bound.identity.documentId !== lease.identity.documentId
      || bound.identity.documentEpoch !== lease.identity.documentEpoch
      || bound.revision !== lease.revision
    ) {
      await this.persistLease(bound);
    }
    return bound;
  }

  private async prepareLeasedMutation(
    request: ScopedBrowserPerformRequest,
    kind: "navigate" | "scroll" | "hover" | "click" | "type" | "upload_file",
  ): Promise<{ disposition: "apply" | "replay_applied"; canonicalParameterHash: string }> {
    const parameterHash = await sha256(stableJson({
      action: request.action,
      target: request.target,
      context_id: request.contextId,
      browser_session_id: request.browserSessionId,
      turn_id: request.turnId,
      args: request.args,
      display: request.display,
    }));
    let disposition: "apply" | "replay_applied" | "unsafe" = "unsafe";
    await this.store.updateLedger((ledger) => {
      const prepared = prepareMutation(ledger, {
        expectedRevision: ledger.revision,
        loadGenerationId: this.store.snapshot.lifecycle.loadGenerationId,
        opId: request.opId,
        actionId: request.actionId,
        contextId: request.contextId,
        browserSessionId: request.browserSessionId,
        turnId: request.turnId,
        kind,
        canonicalParameterHash: parameterHash,
        now: Date.now(),
      });
      if (!prepared.ok) {
        throw new NativeRequestError(
          "The browser mutation could not be journaled.",
          prepared.code === "IDEMPOTENCY_CONFLICT" ? "IDEMPOTENCY_CONFLICT" : "STORAGE_WRITE_FAILED",
        );
      }
      if (prepared.value.disposition === "prepared") disposition = "apply";
      if (
        (prepared.value.disposition === "replay_terminal" || prepared.value.disposition === "durable_receipt")
        && prepared.value.record.stage === "succeeded"
        && prepared.value.record.safeReceipt?.outcome === "applied"
      ) {
        disposition = "replay_applied";
      }
      return prepared.ledger;
    });
    if (disposition === "unsafe") {
      throw new NativeRequestError("The prior mutation cannot be safely replayed.", "OUTCOME_UNKNOWN", "unknown");
    }
    return { disposition, canonicalParameterHash: parameterHash };
  }

  private async open(request: ScopedBrowserPerformRequest): Promise<Record<string, unknown>> {
    if (!request.policy.originGrantId) {
      throw new NativeRequestError("This origin has not been authorized by Agent Zero.", "APPROVAL_REQUIRED");
    }
    const url = exactHttpUrl(request.args.url);
    const parameterHash = await sha256(stableJson({
      action: request.action,
      context_id: request.contextId,
      browser_session_id: request.browserSessionId,
      turn_id: request.turnId,
      args: request.args,
      display: request.display,
    }));
    let preparedDisposition = "";
    await this.store.updateLedger((ledger) => {
      const prepared = prepareMutation(ledger, {
        expectedRevision: ledger.revision,
        loadGenerationId: this.store.snapshot.lifecycle.loadGenerationId,
        opId: request.opId,
        actionId: request.actionId,
        contextId: request.contextId,
        browserSessionId: request.browserSessionId,
        turnId: request.turnId,
        kind: "open",
        canonicalParameterHash: parameterHash,
        now: Date.now(),
      });
      if (!prepared.ok) {
        throw new NativeRequestError("The browser mutation could not be journaled.", prepared.code === "IDEMPOTENCY_CONFLICT" ? "IDEMPOTENCY_CONFLICT" : "STORAGE_WRITE_FAILED");
      }
      preparedDisposition = prepared.value.disposition;
      return prepared.ledger;
    });
    if (preparedDisposition !== "prepared") {
      throw new NativeRequestError("The prior mutation cannot be safely replayed.", "OUTCOME_UNKNOWN", "unknown");
    }
    this.assertNotCanceled(request);
    await this.transitionOpenMutation(request.actionId, "prepared", "effect_started");
    assertBeforeDeadline(request);
    this.markEffectInvoked(request);

    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.create({ url: url.href, active: request.display.foreground });
    } catch {
      await this.transitionOpenMutation(request.actionId, "effect_started", "failed", {
        outcome: "not_applied",
        code: "TAB_NOT_FOUND",
        leaseHandleDigest: null,
      });
      throw new NativeRequestError("Chrome could not create the requested tab.", "TAB_NOT_FOUND");
    }
    if (typeof tab.id !== "number" || typeof tab.windowId !== "number") {
      const removed = typeof tab.id === "number" ? await this.removeTabIfPresent(tab.id, request) : false;
      await this.transitionOpenMutation(
        request.actionId,
        "effect_started",
        removed ? "failed" : "outcome_unknown",
        {
          outcome: removed ? "applied" : "unknown",
          code: removed ? "OPEN_ROLLED_BACK" : "TAB_IDENTITY_MISMATCH",
          leaseHandleDigest: null,
        },
      );
      throw new NativeRequestError("Chrome returned an incomplete tab identity.", "OUTCOME_UNKNOWN", "unknown");
    }

    try {
      // Finalization waits for this already-invoked open to establish its
      // lease. It may finish only under the original connection authority.
      this.assertCapturedAuthority(request);
    } catch (error) {
      await this.transitionOpenMutation(request.actionId, "effect_started", "outcome_unknown", {
        outcome: "unknown", code: "CONNECTION_LOST", leaseHandleDigest: null,
      });
      throw error;
    }
    const snapshot = this.store.snapshot;
    const tabHandle = createTabHandle(snapshot.lifecycle.loadGenerationId);
    const groupIntentId = `a0grp1.${crypto.randomUUID()}`;
    const dispositionValue = request.args.disposition;
    const disposition: LeaseDisposition =
      dispositionValue === "deliverable" || dispositionValue === "handoff" ? dispositionValue : "ephemeral";
    let lease = createLease({
      tabHandle,
      loadGenerationId: snapshot.lifecycle.loadGenerationId,
      contextId: request.contextId,
      browserSessionId: request.browserSessionId,
      turnId: request.turnId,
      origin: "created",
      disposition,
      siteOrigin: url.origin,
      identity: {
        browserInstanceId: snapshot.session.browserInstanceId,
        providerTabId: tab.id,
        providerWindowId: tab.windowId,
        documentId: null,
        documentEpoch: 0,
      },
      groupIntentId,
    });

    const leaseIdDigest = await sha256(lease.leaseId);
    const leaseDigest = await sha256(tabHandle);
    const identityDigest = await sha256(stableJson(lease.identity));
    const pathDigest = await sha256(url.pathname);
    const shadow = createDurableLeaseShadow({
      lease,
      rawUrl: url.href,
      leaseIdDigest,
      leaseHandleDigest: leaseDigest,
      exactIdentityDigest: identityDigest,
      digestPath: () => pathDigest,
      now: Date.now(),
    });

    try {
      let persistedEvent: Parameters<CriticalEventRelay["publishPersisted"]>[0] | null = null;
      await this.store.updateBoth((current) => {
        const durable = upsertDurableLease(current.ledger, {
          expectedRevision: current.ledger.revision,
          shadow,
          now: Date.now(),
        });
        if (!durable.ok) throw new NativeRequestError("The tab lease could not be persisted.", "STORAGE_WRITE_FAILED");
        const event = appendLeaseChangedEvent(durable.ledger, {
          previous: null,
          lease,
          leaseIdDigest,
          browserIdDigest: leaseDigest,
          opId: request.opId,
          actionId: request.actionId,
          now: Date.now(),
        });
        if (!event.ok) throw new NativeRequestError("The tab lease event could not be persisted.", "STORAGE_WRITE_FAILED");
        persistedEvent = event.event;
        return {
          ...current,
          ledger: event.ledger,
          session: {
            ...current.session,
            leasesByHandle: { ...current.session.leasesByHandle, [tabHandle]: lease },
          },
        };
      });
      if (persistedEvent) this.criticalEvents.publishPersisted(persistedEvent);

      let intent = this.store.snapshot.session.groups.intentsByBrowserSession[request.browserSessionId]
        || createTaskGroupIntent({
          intentId: groupIntentId,
          loadGenerationId: snapshot.lifecycle.loadGenerationId,
          browserSessionId: request.browserSessionId,
          title: typeof request.args.task_title === "string" ? request.args.task_title : "Agent Zero",
          color: "cyan",
        });
      if (intent.intentId !== lease.groupIntentId) {
        lease = { ...lease, groupIntentId: intent.intentId, revision: lease.revision + 1 };
      }
      const placement = planGroupPlacement(lease, intent);
      if (placement.action === "create_and_join" || placement.action === "join_existing") {
        lease = beginCorrelatedGroupMove(lease, request.actionId, {
          providerWindowId: placement.providerWindowId,
          providerGroupId: placement.action === "join_existing" ? placement.providerGroupId : "new",
        });
        await this.persistLease(lease);
        this.assertCapturedAuthority(request);
        const providerGroupId = await chrome.tabs.group({
          tabIds: tab.id,
          ...(placement.action === "join_existing"
            ? { groupId: placement.providerGroupId }
            : { createProperties: { windowId: placement.providerWindowId } }),
        });
        if (placement.action === "create_and_join") {
          this.assertCapturedAuthority(request);
          await chrome.tabGroups.update(providerGroupId, { title: placement.title, color: placement.color });
        }
        const bound = bindProviderGroup(intent, tab.windowId, providerGroupId);
        if (!bound.ok) throw new NativeRequestError("The task group identity conflicted.", "INVALID_STATE");
        intent = bound.intent;
        lease = observeTabGroupChange(lease, {
          providerWindowId: tab.windowId,
          providerGroupId,
          correlatedActionId: request.actionId,
        });
        await this.store.updateSession((session) => ({ ...session, groups: upsertGroupIntent(session.groups, intent) }));
        await this.persistLease(lease);
      }

      await this.transitionOpenMutation(request.actionId, "effect_started", "succeeded", {
        outcome: "applied",
        code: null,
        leaseHandleDigest: leaseDigest,
      });
      return {
        lease_id: lease.leaseId,
        browser_id: tabHandle,
        tab_handle: tabHandle,
        origin: url.origin,
        disposition,
        grouped: lease.providerGroupId !== null,
      };
    } catch (error) {
      const removed = await this.removeTabIfPresent(tab.id, request);
      const terminalState = removed ? "failed" : "outcome_unknown";
      const leaseState = removed ? { ...lease, state: "closed" as const } : { ...lease, state: "outcome_unknown" as const };
      try {
        await this.persistLease(leaseState);
      } catch {
        // Continue recording the operation outcome independently when possible.
      }
      try {
        await this.transitionOpenMutation(request.actionId, "effect_started", terminalState, {
          outcome: removed ? "applied" : "unknown",
          code: removed ? "OPEN_ROLLED_BACK" : "OUTCOME_UNKNOWN",
          leaseHandleDigest: leaseDigest,
        });
      } catch {
        // The caller still receives an error and the operation is never treated as replayable.
      }
      if (!removed) {
        throw new NativeRequestError("The open operation outcome is unknown.", "OUTCOME_UNKNOWN", "unknown");
      }
      throw error;
    }
  }

  private async transitionOpenMutation(
    actionId: string,
    expectedStage: "prepared" | "effect_started",
    stage: "effect_started" | "succeeded" | "failed" | "outcome_unknown",
    safeReceipt: { outcome: "not_applied" | "applied" | "unknown"; code: string | null; leaseHandleDigest: string | null } | null = null,
  ): Promise<void> {
    await this.transitionMutationRecord(actionId, expectedStage, stage, safeReceipt);
  }

  private async transitionMutationRecord(
    actionId: string,
    expectedStage: DurableMutationStage,
    stage: DurableMutationStage,
    safeReceipt: { outcome: "not_applied" | "applied" | "unknown"; code: string | null; leaseHandleDigest: string | null } | null = null,
  ): Promise<void> {
    await this.store.updateLedger((ledger) => {
      const result = transitionMutation(ledger, {
        expectedRevision: ledger.revision,
        loadGenerationId: this.store.snapshot.lifecycle.loadGenerationId,
        actionId,
        expectedStage,
        stage,
        safeReceipt,
        now: Date.now(),
      });
      if (!result.ok) throw new NativeRequestError("The browser mutation journal could not advance.", "STORAGE_WRITE_FAILED");
      return result.ledger;
    });
  }

  private async persistLease(lease: TabLease, rawUrl?: string): Promise<void> {
    const leaseIdDigest = await sha256(lease.leaseId);
    const leaseHandleDigest = await sha256(lease.tabHandle);
    const exactIdentityDigest = await sha256(stableJson(lease.identity));
    const pathDigest = rawUrl === undefined ? null : await sha256(new URL(rawUrl).pathname);
    const urlIdentity = rawUrl === undefined || pathDigest === null
      ? null
      : redactUrlIdentity(rawUrl, () => pathDigest);
    let persistedEvent: Parameters<CriticalEventRelay["publishPersisted"]>[0] | null = null;
    await this.store.updateBoth((snapshot) => ({
      ...snapshot,
      ...(() => {
        const existing = snapshot.ledger.leases.find(
          (shadow) => shadow.leaseHandleDigest === leaseHandleDigest,
        );
        if (!existing) {
          throw new NativeRequestError("The exact durable lease shadow is missing.", "STORAGE_WRITE_FAILED");
        }
        if (existing.leaseIdDigest !== leaseIdDigest) {
          throw new NativeRequestError("The durable lease identity does not match.", "STORAGE_WRITE_FAILED");
        }
        const now = Date.now();
        const durable = existing.state === lease.state
          ? upsertDurableLease(snapshot.ledger, {
            expectedRevision: snapshot.ledger.revision,
            shadow: {
              ...existing,
              providerTabId: lease.identity.providerTabId,
              providerWindowId: lease.identity.providerWindowId,
              providerGroupId: lease.providerGroupId,
              disposition: lease.disposition,
              state: lease.state,
              userIntervened: lease.userIntervened,
              exactIdentityDigest,
              finalizationControlId: lease.finalizationControlId,
              retentionReason: lease.retentionReason,
              ...(urlIdentity === null ? {} : { urlIdentity }),
              updatedAt: now,
            },
            now,
          })
          : transitionDurableLease(snapshot.ledger, {
            expectedRevision: snapshot.ledger.revision,
            expectedLeaseIdDigest: leaseIdDigest,
            leaseHandleDigest,
            expectedExactIdentityDigest: existing.exactIdentityDigest,
            expectedState: existing.state,
            state: lease.state,
            now,
            providerTabId: lease.identity.providerTabId,
            providerWindowId: lease.identity.providerWindowId,
            providerGroupId: lease.providerGroupId,
            exactIdentityDigest,
            disposition: lease.disposition,
            userIntervened: lease.userIntervened,
            finalizationControlId: lease.finalizationControlId,
            retentionReason: lease.retentionReason,
          });
        if (!durable.ok) {
          throw new NativeRequestError("The exact durable lease shadow could not be updated.", "STORAGE_WRITE_FAILED");
        }
        const event = appendLeaseChangedEvent(durable.ledger, {
          previous: existing,
          lease,
          leaseIdDigest,
          browserIdDigest: leaseHandleDigest,
          now,
        });
        if (!event.ok) {
          throw new NativeRequestError("The exact lease change event could not be journaled.", "STORAGE_WRITE_FAILED");
        }
        persistedEvent = event.event;
        return {
          ledger: event.ledger,
          session: {
            ...snapshot.session,
            leasesByHandle: { ...snapshot.session.leasesByHandle, [lease.tabHandle]: lease },
          },
        };
      })(),
    }));
    if (persistedEvent) this.criticalEvents.publishPersisted(persistedEvent);
  }

  private async removeTabIfPresent(providerTabId: number, request: ScopedBrowserPerformRequest): Promise<boolean> {
    try {
      // A failed open must not roll back a tab under replacement authority.
      this.assertCapturedAuthority(request);
      await chrome.tabs.remove(providerTabId);
      return true;
    } catch {
      return false;
    }
  }

  private async takeOver(lease: TabLease, reason: Parameters<typeof markLeaseUserTakeover>[1]): Promise<void> {
    const beforeRelease = this.currentMatchingLease(lease);
    if (!beforeRelease || (beforeRelease.state !== "active" && beforeRelease.state !== "finalizing")) return;
    await this.cancelPendingChallenges((challenge) =>
      challenge.loadGenerationId === beforeRelease.loadGenerationId
      && challenge.leaseId === beforeRelease.leaseId
      && challenge.tabHandle === beforeRelease.tabHandle,
    "CANCELED");
    const pending = [...this.pendingArtifacts.values()].find(
      (artifact) => artifact.request.target?.tabHandle === beforeRelease.tabHandle
        && artifact.request.contextId === beforeRelease.contextId
        && artifact.request.browserSessionId === beforeRelease.browserSessionId
        && artifact.request.turnId === beforeRelease.turnId,
    );
    if (pending) await this.abortPendingArtifact(pending, "CANCELED", "USER_INTERVENED");
    await this.removeOverlay(beforeRelease);
    let current = this.currentMatchingLease(beforeRelease);
    if (!current || (current.state !== "active" && current.state !== "finalizing")) return;
    if (current.debuggerAttached) {
      const detached = await this.debuggerHost.detachLease(current);
      if (!detached) {
        await this.persistLease({
          ...current,
          state: "retained",
          userIntervened: true,
          userTakeoverReason: reason,
          overlayAttached: false,
          retentionReason: "outcome_unknown",
          revision: current.revision + 1,
        });
        return;
      }
      current = { ...current, debuggerAttached: false, revision: current.revision + 1 };
      await this.persistLease(current);
    }
    await this.persistLease(markLeaseUserTakeover(current, reason));
  }
}
