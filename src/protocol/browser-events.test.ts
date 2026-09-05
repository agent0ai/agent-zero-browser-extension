import { describe, expect, it } from "vitest";

import {
  BrowserEventSchemaError,
  buildBrowserAckEventsResult,
  buildBrowserEventParams,
  parseBrowserAckEventsParams,
  parseBrowserEventParams,
  type CriticalBrowserEventRecord,
} from "./browser-events";

const DIGEST = "a".repeat(64);

function leaseEvent(): CriticalBrowserEventRecord {
  return {
    eventId: "event-one",
    loadGenerationId: "generation-one",
    sequence: 1,
    delivery: "critical",
    eventType: "lease.changed",
    observedAt: 10,
    contextId: "context-one",
    browserSessionId: "session-one",
    turnId: "turn-one",
    opId: "operation-one",
    actionId: "action-one",
    data: {
      leaseIdDigest: DIGEST,
      browserIdDigest: DIGEST,
      state: "active",
      ownership: "created",
      disposition: "ephemeral",
      change: "created",
      reasonCode: null,
    },
  };
}

describe("critical browser event protocol", () => {
  it("builds and parses the exact redacted lease event envelope", () => {
    const wire = buildBrowserEventParams(leaseEvent());
    expect(wire).toEqual({
      contract_version: 1,
      event_id: "event-one",
      load_generation_id: "generation-one",
      event_sequence: 1,
      delivery: "critical",
      event_type: "lease.changed",
      observed_at_ms: 10,
      context_id: "context-one",
      browser_session_id: "session-one",
      turn_id: "turn-one",
      op_id: "operation-one",
      action_id: "action-one",
      data: {
        lease_id_digest: DIGEST,
        browser_id_digest: DIGEST,
        state: "active",
        ownership: "created",
        disposition: "ephemeral",
        change: "created",
        reason_code: null,
      },
    });
    expect(parseBrowserEventParams(wire)).toEqual(leaseEvent());
  });

  it("round-trips a redacted exact site challenge event", () => {
    const challenge: CriticalBrowserEventRecord = {
      eventId: "event-challenge",
      loadGenerationId: "generation-one",
      sequence: 2,
      delivery: "critical",
      eventType: "challenge.required",
      observedAt: 2_000,
      contextId: "context-one",
      browserSessionId: "session-one",
      turnId: "turn-one",
      opId: "op-one",
      actionId: "action-one",
      data: {
        challengeId: "challenge-one",
        kind: "site",
        origin: "https://other.example",
        actionClass: "navigate",
        canonicalParameterHash: "1".repeat(64),
        targetFingerprint: "2".repeat(64),
        leaseIdDigest: "3".repeat(64),
        browserIdDigest: "4".repeat(64),
        documentId: null,
        documentEpoch: 0,
        summary: "Allow Agent Zero to work on other.example?",
        options: ["deny", "allow_once", "allow_turn"],
        expiresAtMs: 10_000,
      },
    };
    const wire = buildBrowserEventParams(challenge);
    expect(wire.data).not.toHaveProperty("url");
    expect(parseBrowserEventParams(wire)).toEqual(challenge);
    expect(() => parseBrowserEventParams({
      ...wire,
      data: { ...wire.data, options: ["allow_once", "deny", "allow_turn"] },
    })).toThrow(BrowserEventSchemaError);
  });

  it("round-trips only the redacted one-click action challenge", () => {
    const challenge: CriticalBrowserEventRecord = {
      eventId: "event-click-challenge",
      loadGenerationId: "generation-one",
      sequence: 3,
      delivery: "critical",
      eventType: "challenge.required",
      observedAt: 2_000,
      contextId: "context-one",
      browserSessionId: "session-one",
      turnId: "turn-one",
      opId: "op-one",
      actionId: "action-one",
      data: {
        challengeId: "challenge-click",
        kind: "action",
        origin: "https://example.com",
        actionClass: "unknown",
        canonicalParameterHash: "1".repeat(64),
        targetFingerprint: "2".repeat(64),
        leaseIdDigest: "3".repeat(64),
        browserIdDigest: "4".repeat(64),
        documentId: "document-one",
        documentEpoch: 2,
        summary: "Allow Agent Zero to click the highlighted control?",
        options: ["decline", "approve_once"],
        dataClassification: "none",
        expiresAtMs: 10_000,
      },
    };
    const wire = buildBrowserEventParams(challenge);
    expect(parseBrowserEventParams(wire)).toEqual(challenge);
    expect(wire.data).not.toHaveProperty("ref");
    expect(wire.data).not.toHaveProperty("name");
    expect(() => parseBrowserEventParams({
      ...wire,
      data: { ...wire.data, options: ["approve_once", "decline"] },
    })).toThrow(BrowserEventSchemaError);
  });

  it("round-trips a type challenge with only its tagged text digest", () => {
    const challenge: CriticalBrowserEventRecord = {
      eventId: "event-type-challenge",
      loadGenerationId: "generation-one",
      sequence: 4,
      delivery: "critical",
      eventType: "challenge.required",
      observedAt: 2_000,
      contextId: "context-one",
      browserSessionId: "session-one",
      turnId: "turn-one",
      opId: "op-one",
      actionId: "action-one",
      data: {
        challengeId: "challenge-type",
        kind: "action",
        origin: "https://example.com",
        actionClass: "sensitive_input",
        canonicalParameterHash: "1".repeat(64),
        targetFingerprint: "2".repeat(64),
        leaseIdDigest: "3".repeat(64),
        browserIdDigest: "4".repeat(64),
        documentId: "document-one",
        documentEpoch: 2,
        summary: "Allow Agent Zero to type into the highlighted field?",
        options: ["decline", "approve_once"],
        dataClassification: { kind: "text", sensitivity: "sensitive", textSha256: "5".repeat(64) },
        expiresAtMs: 10_000,
      },
    };
    const wire = buildBrowserEventParams(challenge);
    expect(parseBrowserEventParams(wire)).toEqual(challenge);
    expect(wire.data).toMatchObject({
      data_classification: { kind: "text", sensitivity: "sensitive", text_sha256: "5".repeat(64) },
    });
    expect(JSON.stringify(wire)).not.toContain("proposed_text");
    expect(() => parseBrowserEventParams({
      ...wire,
      data: {
        ...wire.data,
        data_classification: { kind: "text", sensitivity: "sensitive", text_sha256: "5".repeat(64), text: "x" },
      },
    })).toThrow(BrowserEventSchemaError);
  });

  it("rejects additive, inconsistent, and raw browsing metadata", () => {
    const wire = buildBrowserEventParams(leaseEvent());
    expect(() => parseBrowserEventParams({ ...wire, url: "https://example.test/private" }))
      .toThrow(BrowserEventSchemaError);
    expect(() => parseBrowserEventParams({
      ...wire,
      data: { ...wire.data, state: "closed" },
    })).toThrow(BrowserEventSchemaError);
    expect(() => parseBrowserEventParams({
      ...wire,
      data: { ...wire.data, provider_tab_id: 42 },
    })).toThrow(BrowserEventSchemaError);
  });

  it("requires a generation-qualified contiguous acknowledgement cursor", () => {
    const parsed = parseBrowserAckEventsParams({
      contract_version: 1,
      load_generation_id: "generation-one",
      highest_contiguous_event_sequence: 4,
    });
    expect(parsed).toEqual({
      contractVersion: 1,
      loadGenerationId: "generation-one",
      highestContiguousEventSequence: 4,
    });
    expect(buildBrowserAckEventsResult(parsed)).toEqual({
      contract_version: 1,
      load_generation_id: "generation-one",
      highest_contiguous_event_sequence: 4,
      status: "acknowledged",
    });
    expect(() => parseBrowserAckEventsParams({
      contract_version: 1,
      highest_contiguous_event_sequence: 4,
    })).toThrow(BrowserEventSchemaError);
  });
});
