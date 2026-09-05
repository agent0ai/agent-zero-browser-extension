import { describe, expect, it } from "vitest";

import {
  ContextSchemaError,
  buildContextSendMessageParams,
  buildContextSubscribeParams,
  parseContextEventNotification,
  parseContextListResult,
  parseContextSnapshotNotification,
} from "./context";

const summary = {
  context_id: "context-one",
  label: "Research plans",
  kind: "task",
  status: "running",
  created_at_ms: 1,
  updated_at_ms: 2,
};

const message = {
  context_id: "context-one",
  sequence: 2,
  event: "message",
  data: { role: "assistant", text: "I found two plans." },
  timestamp_ms: 3,
};

describe("context native protocol", () => {
  it("parses bounded advertised contexts and rejects additive fields", () => {
    expect(parseContextListResult({ contract_version: 1, contexts: [summary] })).toEqual({
      contractVersion: 1,
      contexts: [{
        contextId: "context-one",
        label: "Research plans",
        kind: "task",
        status: "running",
        createdAtMs: 1,
        updatedAtMs: 2,
      }],
    });
    expect(() => parseContextListResult({
      contract_version: 1,
      contexts: [{ ...summary, api_key: "forbidden" }],
    })).toThrow(ContextSchemaError);
  });

  it("preserves paging cursors and validates projected event context/order", () => {
    expect(parseContextSnapshotNotification({
      contract_version: 1,
      context_id: "context-one",
      events: [message],
      last_sequence: 2,
      complete: false,
      history_before: 1,
      has_more_history: true,
    })).toMatchObject({ contextId: "context-one", lastSequence: 2, historyBefore: 1, hasMoreHistory: true });

    expect(() => parseContextSnapshotNotification({
      contract_version: 1,
      context_id: "context-one",
      events: [{ ...message, context_id: "context-two" }],
      last_sequence: 2,
      complete: false,
    })).toThrow(ContextSchemaError);
    expect(() => parseContextSnapshotNotification({
      contract_version: 1,
      context_id: "context-one",
      events: [{ ...message, sequence: 3 }, message],
      last_sequence: 3,
      complete: false,
    })).toThrow(ContextSchemaError);
  });

  it("accepts only known safe event projections", () => {
    expect(parseContextEventNotification({ contract_version: 1, ...message, last_sequence: 4 })).toMatchObject({
      event: "message",
      lastSequence: 4,
      data: { role: "assistant", text: "I found two plans." },
    });
    expect(() => parseContextEventNotification({
      contract_version: 1,
      ...message,
      last_sequence: 4,
      event: "html",
      data: { markup: "<button>Approve</button>" },
    })).toThrow(ContextSchemaError);
  });

  it("builds unambiguous subscriptions and bounded message requests", () => {
    expect(buildContextSubscribeParams({ contextId: "context-one", history: "tail" })).toEqual({
      contract_version: 1,
      context_id: "context-one",
      history: "tail",
    });
    expect(() => buildContextSubscribeParams({ contextId: "context-one", from: 2, history: "tail" }))
      .toThrow(ContextSchemaError);
    expect(buildContextSendMessageParams({
      contextId: "context-one",
      clientMessageId: "client-one",
      text: "Continue with the comparison.",
    })).toEqual({
      contract_version: 1,
      context_id: "context-one",
      client_message_id: "client-one",
      text: "Continue with the comparison.",
      artifact_ids: [],
      tab_candidates: [],
    });
    expect(() => buildContextSendMessageParams({
      contextId: "context-one",
      clientMessageId: "client-one",
      text: "   ",
    })).toThrow(ContextSchemaError);
    expect(() => buildContextSendMessageParams({
      contextId: "context-one",
      clientMessageId: "client-one",
      text: "Attach this.",
      artifactIds: ["artifact-one"],
    })).toThrow(ContextSchemaError);
  });
});
