import { describe, expect, it } from "vitest";

import {
  ChallengeSchemaError,
  buildBrowserResolveChallengeResult,
  parseBrowserResolveChallengeRequest,
  parseBrowserResolveChallengeResult,
} from "./challenges";

const request = () => ({
  contract_version: 1,
  control_id: "control-one",
  challenge_id: "challenge-one",
  context_id: "context-one",
  browser_session_id: "session-one",
  turn_id: "turn-one",
  op_id: "op-one",
  action_id: "action-one",
  tab_handle: "tab-one",
  document_id: null,
  document_epoch: 0,
  canonical_parameter_hash: "1".repeat(64),
  target_fingerprint: "2".repeat(64),
  origin: "https://other.example",
  action_class: "navigate",
  decision: "allow_once",
  grant: {
    origin_grant_id: "grant-one",
    scope: "operation",
    origin: "https://other.example",
    expires_at_ms: 4_000,
  },
});

describe("site challenge controls", () => {
  it("parses the exact operation-bound allow control and result", () => {
    const parsed = parseBrowserResolveChallengeRequest(request());
    expect(parsed).toMatchObject({
      controlId: "control-one",
      challengeId: "challenge-one",
      documentId: null,
      documentEpoch: 0,
      decision: "allow_once",
      grant: { scope: "operation", origin: "https://other.example" },
    });
    expect(parseBrowserResolveChallengeResult(buildBrowserResolveChallengeResult(parsed))).toEqual({
      contract_version: 1,
      control_id: "control-one",
      challenge_id: "challenge-one",
      status: "resolved",
      decision: "allow_once",
    });
  });

  it("rejects extra fields, noncanonical origins, and decision/grant scope mismatches", () => {
    expect(() => parseBrowserResolveChallengeRequest({ ...request(), local_choice: true }))
      .toThrow(ChallengeSchemaError);
    expect(() => parseBrowserResolveChallengeRequest({ ...request(), origin: "https://other.example/" }))
      .toThrow(ChallengeSchemaError);
    expect(() => parseBrowserResolveChallengeRequest({
      ...request(),
      decision: "allow_turn",
    })).toThrow(ChallengeSchemaError);
    expect(() => parseBrowserResolveChallengeRequest({
      ...request(),
      decision: "deny",
    })).toThrow(ChallengeSchemaError);
  });
});

describe("action challenge controls", () => {
  const actionRequest = () => ({
    contract_version: 1,
    control_id: "control-click",
    challenge_id: "challenge-click",
    context_id: "context-one",
    browser_session_id: "session-one",
    turn_id: "turn-one",
    op_id: "op-one",
    action_id: "action-one",
    tab_handle: "tab-one",
    document_id: "document-one",
    document_epoch: 2,
    canonical_parameter_hash: "3".repeat(64),
    target_fingerprint: "4".repeat(64),
    origin: "https://example.com",
    action_class: "unknown",
    data_classification: "none",
    decision: "approve_once",
    grant: {
      action_grant_id: "grant-click",
      scope: "operation",
      origin: "https://example.com",
      action_class: "unknown",
      canonical_parameter_hash: "3".repeat(64),
      target_fingerprint: "4".repeat(64),
      data_classification: "none",
      expires_at_ms: 4_000,
    },
  });

  it("parses only the exact one-action approval binding", () => {
    const parsed = parseBrowserResolveChallengeRequest(actionRequest());
    expect(parsed).toMatchObject({
      actionClass: "unknown",
      dataClassification: "none",
      decision: "approve_once",
      grant: { actionGrantId: "grant-click", scope: "operation" },
    });
    expect(parseBrowserResolveChallengeResult(buildBrowserResolveChallengeResult(parsed))).toEqual({
      contract_version: 1,
      control_id: "control-click",
      challenge_id: "challenge-click",
      status: "resolved",
      decision: "approve_once",
    });
    expect(() => parseBrowserResolveChallengeRequest({ ...actionRequest(), data_classification: "text" }))
      .toThrow(ChallengeSchemaError);
    expect(() => parseBrowserResolveChallengeRequest({ ...actionRequest(), document_id: null }))
      .toThrow(ChallengeSchemaError);
    expect(() => parseBrowserResolveChallengeRequest({ ...actionRequest(), decision: "decline" }))
      .toThrow(ChallengeSchemaError);
  });

  it("binds only the exact sensitive text digest classification", () => {
    const dataClassification = {
      kind: "text",
      sensitivity: "sensitive",
      text_sha256: "5".repeat(64),
    };
    const parsed = parseBrowserResolveChallengeRequest({
      ...actionRequest(),
      action_class: "sensitive_input",
      data_classification: dataClassification,
      grant: {
        ...actionRequest().grant,
        action_class: "sensitive_input",
        data_classification: dataClassification,
      },
    });
    expect(parsed).toMatchObject({
      actionClass: "sensitive_input",
      dataClassification: { kind: "text", sensitivity: "sensitive", textSha256: "5".repeat(64) },
      grant: { dataClassification: { textSha256: "5".repeat(64) } },
    });
    expect(() => parseBrowserResolveChallengeRequest({
      ...actionRequest(),
      data_classification: { ...dataClassification, text: "must-never-cross" },
    })).toThrow(ChallengeSchemaError);
    expect(() => parseBrowserResolveChallengeRequest({
      ...actionRequest(),
      data_classification: { ...dataClassification, text_sha256: "A".repeat(64) },
    })).toThrow(ChallengeSchemaError);
  });
});
