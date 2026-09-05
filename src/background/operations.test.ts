import { describe, expect, it } from "vitest";

import {
  OperationValidationError,
  assertBeforeDeadline,
  parseBrowserCancelRequest,
  parseBrowserFinalizeRequest,
  parseBrowserPerformRequest,
} from "./operations";

const performFixture = () => ({
  contract_version: 1,
  op_id: "op-one",
  action_id: "action-one",
  context_id: "context-one",
  browser_session_id: "session-one",
  turn_id: "turn-one",
  action: "open",
  args: { url: "https://example.com" },
  timeout_ms: 1_000,
  required_capabilities: ["tab_leases_v1"],
  policy: { origin_grant_id: "grant-one", action_grant_id: null },
  display: { cursor: false, foreground: false },
});

describe("browser operation validation", () => {
  it("normalizes a canonical operation and computes its wall-clock deadline", () => {
    expect(parseBrowserPerformRequest(performFixture(), 100)).toEqual(
      expect.objectContaining({
        contractVersion: 1,
        action: "open",
        target: null,
        timeoutMs: 1_000,
        receivedAtMs: 100,
        deadlineAtMs: 1_100,
      }),
    );
  });

  it.each([
    [{ ...performFixture(), contract_version: 2 }, "contract_version"],
    [{ ...performFixture(), action: "Open" }, "action"],
    [{ ...performFixture(), args: [] }, "args"],
    [{ ...performFixture(), timeout_ms: 120_001 }, "timeout_ms"],
    [{ ...performFixture(), target: { tab_handle: 12 } }, "target.tab_handle"],
    [{ ...performFixture(), required_capabilities: ["tab_leases_v1", 1] }, "required_capabilities"],
  ])("rejects malformed canonical input %#", (value, field) => {
    try {
      parseBrowserPerformRequest(value);
    } catch (error) {
      expect(error).toBeInstanceOf(OperationValidationError);
      expect((error as OperationValidationError).field).toBe(field);
      return;
    }
    throw new Error("Expected validation failure");
  });

  it("rejects a request at its wall-clock deadline", () => {
    expect(() => assertBeforeDeadline({ deadlineAtMs: 50 }, 50)).toThrow("deadline expired");
  });

  it("validates bounded finalization dispositions", () => {
    expect(
      parseBrowserFinalizeRequest({
        contract_version: 1,
        control_id: "control-one",
        context_id: "context-one",
        browser_session_id: "session-one",
        turn_id: "turn-one",
        dispositions: { "lease-one": "deliverable", "lease-two": "ephemeral" },
        reason: "completed",
      }),
    ).toEqual(expect.objectContaining({ controlId: "control-one", dispositions: { "lease-one": "deliverable", "lease-two": "ephemeral" } }));
  });

  it("requires the exact transport-bound cancellation identity and rejects unknown fields", () => {
    const cancel = {
      contract_version: 1,
      control_id: "control-one",
      op_id: "op-one",
      action_id: "action-one",
      context_id: "context-one",
      browser_session_id: "session-one",
      turn_id: "turn-one",
      reason: "turn stopped",
    };
    expect(parseBrowserCancelRequest(cancel)).toEqual({
      contractVersion: 1,
      controlId: "control-one",
      opId: "op-one",
      actionId: "action-one",
      contextId: "context-one",
      browserSessionId: "session-one",
      turnId: "turn-one",
      reason: "turn stopped",
    });
    expect(() => parseBrowserCancelRequest({ ...cancel, browser_session_id: undefined }))
      .toThrow("browser_session_id");
    expect(() => parseBrowserCancelRequest({ ...cancel, unexpected: true }))
      .toThrow("Unknown browser cancellation field");
  });

  it("accepts connection-level status and ensure without operation identity fields", () => {
    for (const action of ["status", "ensure"] as const) {
      const parsed = parseBrowserPerformRequest({
        contract_version: 1,
        action,
        args: {},
        timeout_ms: 1_000,
        required_capabilities: [],
        policy: {},
        display: {},
      }, 10);
      expect(parsed).toMatchObject({
        action,
        opId: null,
        actionId: null,
        contextId: null,
        browserSessionId: null,
        turnId: null,
      });
    }
  });
});
