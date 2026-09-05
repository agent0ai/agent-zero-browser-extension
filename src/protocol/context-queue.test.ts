import { describe, expect, it } from "vitest";
import fixture from "./fixtures/context-queue-approval-v1.json";
import { buildContextQueueAddParams, buildContextQueueItemParams, buildLocalApprovalParams, parseContextQueueProjection, parseContextQueueResult, parseLocalApprovalResult } from "./context";

describe("restricted queue and local approval wire contracts", () => {
  it("uses pathless owned queue schemas and preserves explicit terminal replay states", () => {
    expect(buildContextQueueAddParams({ contextId: "context-A", clientMessageId: "message-A", text: "Draft" })).toEqual({ contract_version: 1, context_id: "context-A", client_message_id: "message-A", text: "Draft" });
    expect(buildContextQueueItemParams("context-A", "queue-A").item_id).toBe("queue-A");
    const projection = { contract_version: 1, context_id: "context-A", message_queue: [{ id: "queue-A", text: "Draft", attachments: [], attachment_count: 0 }] };
    expect(parseContextQueueResult({ ...projection, item_id: "queue-A", status: "sent" }).status).toBe("sent");
    expect(() => parseContextQueueProjection({ ...projection, message_queue: [{ ...projection.message_queue[0], attachments: ["/private/path"] }] })).toThrow();
    expect(() => parseContextQueueProjection({ ...projection, message_queue: [...projection.message_queue, ...projection.message_queue] })).toThrow();
  });
  it("binds explicit approval acknowledgement to challenge and choice", () => {
    const input = { challengeId: "challenge-A", kind: "action" as const, decision: "approve_once" as const };
    expect(buildLocalApprovalParams(input)).toEqual({ contract_version: 1, challenge_id: "challenge-A", kind: "action", decision: "approve_once" });
    const ack = { contract_version: 1, challenge_id: "challenge-A", decision: "approved", control_id: "control-A", status: "accepted" };
    expect(parseLocalApprovalResult(ack, input)).toEqual(ack);
    expect(() => parseLocalApprovalResult({ ...ack, challenge_id: "other" }, input)).toThrow();
    expect(() => buildLocalApprovalParams({ ...input, decision: "allow_turn" })).toThrow();
    expect(buildLocalApprovalParams(input)).toEqual(fixture.action_approval.params);
    expect(parseLocalApprovalResult(fixture.action_approval.result, input)).toEqual(fixture.action_approval.result);
  });
});
