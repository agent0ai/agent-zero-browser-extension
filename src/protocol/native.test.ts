import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_CHUNK_BYTES,
  NativeSchemaError,
  REQUIRED_BRIDGE_SCOPES,
  buildBrowserReconcileResult,
  buildHelloParams,
  buildPairingExchangeParams,
  evaluateActivation,
  normalizePairingCode,
  normalizeServerBaseOrigin,
  parseAgentStatusResult,
  parseBrowserReconcileRequest,
  parseBrowserReconcileResult,
  parseHelloResult,
  parsePairingExchangeResult,
  parsePairingStatusResult,
} from "./native";
import { MAX_NATIVE_MESSAGE_BYTES } from "./rpc";
import { BROWSER_RUNTIME_ACTIONS, BROWSER_RUNTIME_CAPABILITIES } from "../background/browser-runtime";

const EXTENSION_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST = "0".repeat(64);
const PAIRING_CODE = "A0B1-DEADBEEF-0123456789ABCDEFGHJKMNPQRSTVWXYZ";

it("accepts the identical Core reconciliation parity fixture", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/browser-reconcile-v1.json", import.meta.url), "utf8"));
  expect(parseBrowserReconcileRequest(fixture.extension_request)).toEqual(fixture.extension_request);
  expect(parseBrowserReconcileResult(fixture.extension_result)).toEqual(fixture.extension_result);
});

const expectSchemaReason = (callback: () => unknown, reasonCode: string): void => {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(NativeSchemaError);
    expect((error as NativeSchemaError).reasonCode).toBe(reasonCode);
    return;
  }
  throw new Error(`Expected schema validation to fail with ${reasonCode}`);
};

const helloResultFixture = () => ({
  protocol: "a0.browser-bridge.v1",
  contract_version: 1,
  connection_id: "connection-one",
  companion: {
    instance_id: "companion-one",
    version: "0.1.0",
    platform: "darwin",
    arch: "arm64",
  },
  server: {
    state: "paired",
    instance_id: "server-one",
    label: "Agent Zero",
  },
  limits: {
    max_json_frame_bytes: MAX_NATIVE_MESSAGE_BYTES,
    artifact_chunk_bytes: MAX_ARTIFACT_CHUNK_BYTES,
    max_artifact_bytes: MAX_ARTIFACT_BYTES,
  },
  negotiated: {
    actions: ["open", "list"],
    features: ["tab_leases_v1", "tab_groups_v1"],
  },
  activation: {
    principal: "browser_bridge",
    bridge_id: "bridge-one",
    key_generation: 1,
    extension_id: EXTENSION_ID,
    install_instance_id: "install-one",
    server_features: [
      "browser_extension_bridge_v1",
      "connector_browser_control",
      "connector_browser_event",
    ],
    rollout: "available",
    selected_bridge: true,
    heartbeat_fresh: true,
    subject_profile_bound: true,
    legacy_control_plane_inactive: true,
  },
});

describe("native hello and activation schemas", () => {
  it("rejects limited development admission on the production native route", () => {
    expect(() => parseHelloResult({ ...helloResultFixture(), development_admission: {} })).toThrow("HELLO_DEVELOPMENT_ADMISSION_INVALID");
  });

  it("rejects a development profile on the production native route", () => {
    expectSchemaReason(() => parseHelloResult({ ...helloResultFixture(), development: {
      contract: "a0.browser-bridge.development-trust.v1", channel: "local-development",
      connector_session_ready: false, browser_control_ready: false, reason_code: "development_runtime_not_available",
    } }), "HELLO_DEVELOPMENT_INVALID");
  });
  it("builds the frozen hello projection without unproven authority", () => {
    expect(
      buildHelloParams({
        extensionId: EXTENSION_ID,
        extensionVersion: "0.1.0",
        installInstanceId: "install-one",
        loadGenerationId: "generation-one",
        browserFamily: "chrome",
        browserVersion: "146.0.0.0",
        actions: ["open", "list"],
        features: ["tab_leases_v1", "tab_groups_v1"],
        eventCursors: [{ loadGenerationId: "generation-one", lastAckedEventSequence: 41 }],
        inflightOpIds: ["op-one"],
        leaseDigest: `sha256:${DIGEST}`,
      }),
    ).toEqual({
      protocol: "a0.browser-bridge",
      contract: { min: 1, max: 1 },
      extension: {
        id: EXTENSION_ID,
        version: "0.1.0",
        manifest_version: 3,
        install_instance_id: "install-one",
        load_generation_id: "generation-one",
      },
      browser: { family: "chrome", version: "146.0.0.0" },
      capabilities: {
        actions: ["open", "list"],
        features: ["tab_leases_v1", "tab_groups_v1"],
        cdp_domains: [],
      },
      resume: {
        event_cursors: [{ load_generation_id: "generation-one", last_acked_event_sequence: 41 }],
        inflight_op_ids: ["op-one"],
        lease_digest: `sha256:${DIGEST}`,
      },
    });
  });

  it("accepts the bounded page-operation hello surface", () => {
    expect(buildHelloParams({
      extensionId: EXTENSION_ID,
      extensionVersion: "0.1.0",
      installInstanceId: "install-one",
      loadGenerationId: "generation-one",
      browserFamily: "chrome",
      browserVersion: "146",
      actions: ["content", "navigate", "scroll"],
      features: ["semantic_dom_v1", "cursor_v1"],
      eventCursors: [],
      inflightOpIds: [],
      leaseDigest: `sha256:${DIGEST}`,
    }).capabilities).toEqual({
      actions: ["content", "navigate", "scroll"],
      features: ["semantic_dom_v1", "cursor_v1"],
      cdp_domains: [],
    });
  });

  it("negotiates the actual worker surface without granting activation", () => {
    const sent = buildHelloParams({
      extensionId: EXTENSION_ID,
      extensionVersion: "0.1.0",
      installInstanceId: "install-one",
      loadGenerationId: "generation-one",
      browserFamily: "chrome",
      browserVersion: "146",
      actions: BROWSER_RUNTIME_ACTIONS,
      features: BROWSER_RUNTIME_CAPABILITIES,
      eventCursors: [],
      inflightOpIds: [],
      leaseDigest: `sha256:${DIGEST}`,
    });
    const received = parseHelloResult({ ...helloResultFixture(), negotiated: sent.capabilities });
    expect(received.negotiated.actions).toEqual([...BROWSER_RUNTIME_ACTIONS]);
    expect(received.negotiated.features).toEqual([...BROWSER_RUNTIME_CAPABILITIES]);
    expect(sent.capabilities.cdp_domains).toEqual([]);
    expect(evaluateActivation(received, undefined, {
      extensionId: EXTENSION_ID, installInstanceId: "install-one",
      actions: BROWSER_RUNTIME_ACTIONS, features: BROWSER_RUNTIME_CAPABILITIES,
    }).ready).toBe(false);
  });

  it("rejects an unproven raw_cdp_v1 capability", () => {
    expectSchemaReason(
      () => buildHelloParams({
        extensionId: EXTENSION_ID,
        extensionVersion: "0.1.0",
        installInstanceId: "install-one",
        loadGenerationId: "generation-one",
        browserFamily: "chrome",
        browserVersion: "146",
        actions: [],
        features: ["raw_cdp_v1"],
        eventCursors: [],
        inflightOpIds: [],
        leaseDigest: `sha256:${DIGEST}`,
      }),
      "UNPROVEN_CAPABILITY",
    );
  });

  it("requires all local, server, identity, selection, feature, and limit gates", () => {
    const parsed = parseHelloResult(helloResultFixture());
    expect(evaluateActivation(parsed, {
      extensionIdentityApproved: true,
      storageMigrationState: "v1_ready",
      chromePermissionsReady: true,
      legacyControlPlaneInactive: true,
      operationalMethodSurfaceReady: true,
    }, {
      extensionId: EXTENSION_ID,
      installInstanceId: "install-one",
      actions: ["open", "list"],
      features: ["tab_leases_v1", "tab_groups_v1"],
    })).toEqual({ ready: true, blockers: [] });

    const missingEvidence = evaluateActivation(parsed, undefined, {
      extensionId: EXTENSION_ID,
      installInstanceId: "install-one",
      actions: ["open"],
      features: ["tab_leases_v1"],
    });
    expect(missingEvidence.ready).toBe(false);
    expect(missingEvidence.blockers).toEqual(expect.arrayContaining([
      "extension_identity_unapproved",
      "storage_migration_incomplete",
      "chrome_permissions_unverified",
      "legacy_control_plane_active",
      "operational_method_surface_incomplete",
    ]));
  });

  it("rejects invalid activation identity and unsupported wire limits", () => {
    const badIdentity = helloResultFixture();
    badIdentity.activation.key_generation = 0;
    expectSchemaReason(() => parseHelloResult(badIdentity), "HELLO_ACTIVATION_INVALID");

    const oversized = helloResultFixture();
    oversized.limits.max_json_frame_bytes = MAX_NATIVE_MESSAGE_BYTES + 1;
    expectSchemaReason(() => parseHelloResult(oversized), "HELLO_LIMITS_INVALID");
  });
});

describe("native pairing and status schemas", () => {
  it("accepts the exact Core pairing shape and supported grouped presentation", () => {
    expect(normalizePairingCode(PAIRING_CODE.toLowerCase())).toBe(PAIRING_CODE);
    expect(normalizePairingCode("A0B1-DEADBEEF-01234567-89ABCDEF-GHJKMNPQ-RSTVWXYZ")).toBe(
      PAIRING_CODE,
    );
    expect(buildPairingExchangeParams({
      pairingCode: PAIRING_CODE,
      serverBaseOrigin: "http://127.22.33.44:50080/a0/",
    })).toEqual({
      contract_version: 1,
      pairing_code: PAIRING_CODE,
      server_base_origin: "http://127.22.33.44:50080/a0",
    });
  });

  it("accepts only HTTPS or IP loopback HTTP origins", () => {
    expect(normalizeServerBaseOrigin("http://[::1]:50080/")).toBe("http://[::1]:50080");
    expect(normalizeServerBaseOrigin("http://agent.localhost:50080/a0")).toBe("http://agent.localhost:50080/a0");
    expect(normalizeServerBaseOrigin("https://agent.example.test/a0/")).toBe("https://agent.example.test/a0");
    expectSchemaReason(() => normalizeServerBaseOrigin("http://192.168.1.10:50080"), "SERVER_ORIGIN_INVALID");
    expectSchemaReason(() => normalizeServerBaseOrigin("https://agent.example.test/a//b"), "SERVER_ORIGIN_INVALID");
    expectSchemaReason(() => normalizeServerBaseOrigin("https://agent.example.test/a/%62"), "SERVER_ORIGIN_INVALID");
    expectSchemaReason(() => normalizeServerBaseOrigin("https://agent.example.test/a/../b"), "SERVER_ORIGIN_INVALID");
    expectSchemaReason(() => normalizeServerBaseOrigin("https://user@example.test"), "SERVER_ORIGIN_INVALID");
  });

  it("projects only non-secret pairing and agent status fields", () => {
    expect(parsePairingStatusResult({
      contract_version: 1,
      state: "paired",
      server: { label: "Agent Zero", base_origin: "http://localhost:50080" },
      companion: { version: "0.1.0" },
      diagnostics: [],
      ignored_additive_field: true,
    }).state).toBe("paired");

    expect(parsePairingExchangeResult({
      contract_version: 1,
      state: "paired",
      bridge_id: "bridge-one",
      server: {
        instance_id: "server-one",
        label: "Agent Zero",
        base_origin: "http://localhost:50080",
      },
      scopes: [...REQUIRED_BRIDGE_SCOPES],
      policy: { mode: "ask_per_site", ready: true },
    }).scopes).toEqual(REQUIRED_BRIDGE_SCOPES);

    expect(parseAgentStatusResult({
      contract_version: 1,
      server: { state: "reachable", version: "0.9.0", instance_id: "server-one", label: "Agent Zero" },
      active_contexts: { count: 1 },
      selected_browser_backend: { id: "extension:bridge-one", ready: true },
      policy: { mode: "ask_per_site", ready: true },
      diagnostics: [],
    }).selectedBackend.ready).toBe(true);
  });

  it("rejects pairing/status payloads containing secret-shaped fields", () => {
    expectSchemaReason(() => parsePairingStatusResult({
      contract_version: 1,
      state: "paired",
      server: { label: "Agent Zero", base_origin: "http://localhost:50080" },
      companion: { version: "0.1.0" },
      diagnostics: [],
      api_key: "must-not-cross",
    }), "STATUS_SECRET_FIELD_FORBIDDEN");
  });
});

describe("browser reconciliation schemas", () => {
  it("validates and projects expected server intent", () => {
    expect(parseBrowserReconcileRequest({
      contract_version: 1,
      control_id: "control-one",
      expected_contexts: [{
        context_id: "context-one",
        browser_session_id: "session-one",
        active_turn_ids: ["turn-one"],
      }],
      event_cursors: [{ load_generation_id: "generation-one", last_acked_event_sequence: 3 }],
      known_control_ids: ["finalize-one"],
    })).toEqual({
      contract_version: 1,
      control_id: "control-one",
      expected_contexts: [{
        context_id: "context-one",
        browser_session_id: "session-one",
        active_turn_ids: ["turn-one"],
      }],
      event_cursors: [{ load_generation_id: "generation-one", last_acked_event_sequence: 3 }],
      known_control_ids: ["finalize-one"],
    });
  });

  it("accepts a canonical redacted reconciliation projection", () => {
    expect(parseBrowserReconcileResult({
      contract_version: 1,
      control_id: "control-one",
      install_instance_id: "install-one",
      load_generation_id: "generation-one",
      leases: [{
        lease_id: "lease-one",
        tab_handle: "a0t1.generation-one.lease-one",
        load_generation_id: "generation-one",
        context_id: "context-one",
        browser_session_id: "session-one",
        turn_id: "turn-one",
        origin: "created",
        disposition: "ephemeral",
        state: "active",
        site_origin: "https://example.test",
        identity: {
          browser_instance_id: "browser-one",
          provider_tab_id: 4,
          provider_window_id: 2,
          document_id: "document-one",
          document_epoch: 1,
        },
        group_intent_id: "group-one",
        provider_group_id: 3,
        finalization_control_id: null,
        user_intervened: false,
        user_takeover_reason: null,
        is_protected: false,
        is_ambiguous: false,
        unresolved_reconciliation: false,
        overlay_attached: false,
        debugger_attached: false,
        retention_reason: null,
        revision: 1,
      }],
      inflight_operations: [{
        load_generation_id: "generation-one",
        action_id: "action-one",
        kind: "open",
        canonical_parameter_hash: DIGEST,
        stage: "prepared",
        created_at_ms: 10,
        updated_at_ms: 11,
      }],
      terminal_action_receipts: [{
        load_generation_id: "generation-zero",
        action_id: "action-zero",
        kind: "open",
        canonical_parameter_hash: DIGEST,
        stage: "outcome_unknown",
        safe_receipt: { outcome: "unknown", code: "OUTCOME_UNKNOWN", lease_handle_digest: null },
        created_at_ms: 1,
        updated_at_ms: 2,
        acknowledged_at_ms: null,
      }],
      pending_critical_events: [{
        contract_version: 1,
        event_id: "event-one",
        load_generation_id: "generation-one",
        event_sequence: 1,
        delivery: "critical",
        event_type: "lease.changed",
        observed_at_ms: 12,
        context_id: "context-one",
        browser_session_id: "session-one",
        turn_id: "turn-one",
        op_id: null,
        action_id: null,
        data: {
          lease_id_digest: DIGEST,
          browser_id_digest: DIGEST,
          state: "closed",
          ownership: "created",
          disposition: "ephemeral",
          change: "tab_closed",
          reason_code: "TAB_CLOSED",
        },
      }],
      prior_generation_orphans: [{
        load_generation_id: "generation-zero",
        lease_handle_digest: DIGEST,
        exact_identity_digest: "1".repeat(64),
        browser_instance_id: "browser-zero",
        provider_tab_id: 8,
        provider_window_id: 2,
        provider_group_id: null,
        context_id: "context-one",
        browser_session_id: "session-one",
        turn_id: "turn-zero",
        origin: "created",
        disposition: "ephemeral",
        state: "orphan",
        url_identity: { origin: "https://example.test", path_digest: "2".repeat(64) },
        user_intervened: false,
        finalization_control_id: null,
        retention_reason: "generation_mismatch",
        updated_at_ms: 4,
      }],
    }).leases[0].identity.provider_tab_id).toBe(4);
  });

  it("projects internal runtime records into the canonical wire schema", () => {
    const result = buildBrowserReconcileResult({
      controlId: "control-one",
      installInstanceId: "install-one",
      loadGenerationId: "generation-one",
      leases: [{
        leaseId: "lease-one",
        tabHandle: "a0t1.generation-one.lease-one",
        loadGenerationId: "generation-one",
        contextId: "context-one",
        browserSessionId: "session-one",
        turnId: "turn-one",
        origin: "created",
        disposition: "ephemeral",
        state: "active",
        siteOrigin: "https://example.test",
        identity: {
          browserInstanceId: "browser-one",
          providerTabId: 4,
          providerWindowId: 2,
          documentId: null,
          documentEpoch: 0,
        },
        groupIntentId: null,
        providerGroupId: null,
        finalizationControlId: null,
        userIntervened: false,
        userTakeoverReason: null,
        isProtected: false,
        isAmbiguous: false,
        unresolvedReconciliation: false,
        overlayAttached: false,
        debuggerAttached: false,
        retentionReason: null,
        revision: 0,
      }],
      inflightOperations: [{
        loadGenerationId: "generation-one",
        actionId: "action-one",
        kind: "open",
        canonicalParameterHash: DIGEST,
        stage: "prepared",
        safeReceipt: null,
        createdAt: 1,
        updatedAt: 2,
        acknowledgedAt: null,
      }],
      terminalActionReceipts: [{
        loadGenerationId: "generation-zero",
        actionId: "action-zero",
        kind: "open",
        canonicalParameterHash: DIGEST,
        stage: "outcome_unknown",
        safeReceipt: { outcome: "unknown", code: "OUTCOME_UNKNOWN", leaseHandleDigest: null },
        createdAt: 1,
        updatedAt: 2,
        acknowledgedAt: null,
      }],
      pendingCriticalEvents: [{
        eventId: "event-one",
        loadGenerationId: "generation-one",
        sequence: 1,
        delivery: "critical",
        eventType: "lease.changed",
        observedAt: 3,
        contextId: "context-one",
        browserSessionId: "session-one",
        turnId: "turn-one",
        opId: null,
        actionId: null,
        data: {
          leaseIdDigest: DIGEST,
          browserIdDigest: DIGEST,
          state: "closed",
          ownership: "created",
          disposition: "ephemeral",
          change: "tab_closed",
          reasonCode: "TAB_CLOSED",
        },
      }],
      priorGenerationOrphans: [{
        loadGenerationId: "generation-zero",
        leaseHandleDigest: DIGEST,
        exactIdentityDigest: "1".repeat(64),
        browserInstanceId: "browser-zero",
        providerTabId: 8,
        providerWindowId: 2,
        providerGroupId: null,
        contextId: "context-one",
        browserSessionId: "session-one",
        turnId: "turn-zero",
        origin: "created",
        disposition: "ephemeral",
        state: "orphan",
        urlIdentity: { origin: "https://example.test", pathDigest: "2".repeat(64) },
        userIntervened: false,
        finalizationControlId: null,
        retentionReason: "generation_mismatch",
        updatedAt: 4,
      }],
    });
    expect(result.leases[0]).toEqual(expect.objectContaining({
      lease_id: "lease-one",
      tab_handle: "a0t1.generation-one.lease-one",
      load_generation_id: "generation-one",
      site_origin: "https://example.test",
    }));
    expect(result.control_id).toBe("control-one");
    expect(result.inflight_operations[0].created_at_ms).toBe(1);
    expect(result.terminal_action_receipts[0].safe_receipt.outcome).toBe("unknown");
    expect(result.pending_critical_events[0].event_sequence).toBe(1);
    expect(result.prior_generation_orphans[0].url_identity.path_digest).toBe("2".repeat(64));
  });

  it("rejects duplicate intent and non-canonical reconciliation results", () => {
    expectSchemaReason(() => parseBrowserReconcileRequest({
      contract_version: 1,
      control_id: "control-one",
      expected_contexts: [],
      event_cursors: [],
      known_control_ids: ["same", "same"],
    }), "RECONCILE_REQUEST_INVALID");

    expectSchemaReason(() => parseBrowserReconcileResult({
      contract_version: 1,
      control_id: "control-one",
      install_instance_id: "install-one",
      load_generation_id: "generation-one",
      leases: [],
      inflight_operations: [],
      terminal_action_receipts: [],
      pending_critical_events: [],
      prior_generation_orphans: [{ api_key: "must-not-cross" }],
    }), "STATUS_SECRET_FIELD_FORBIDDEN");
  });
});
