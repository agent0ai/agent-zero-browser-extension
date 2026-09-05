import { describe, expect, it } from "vitest";

import {
  ArtifactSchemaError,
  buildArtifactBeginParams,
  buildArtifactChunkParams,
  parseArtifactAck,
  type OutputArtifactBinding,
} from "./artifacts";

const binding: OutputArtifactBinding = {
  contextId: "context-one",
  browserSessionId: "session-one",
  turnId: "turn-one",
  actionId: "action-one",
  opId: "op-one",
  artifactId: "a0art1.00000000-0000-4000-8000-000000000000",
  direction: "output",
  purpose: "screenshot",
};

describe("output artifact protocol", () => {
  it("builds bounded canonical frames and accepts only an exact bound acknowledgement", () => {
    expect(buildArtifactBeginParams(binding, {
      mimeType: "image/png",
      byteCount: 4,
      sha256: `sha256:${"a".repeat(64)}`,
    })).toEqual(expect.objectContaining({
      contract_version: 1,
      artifact_id: binding.artifactId,
      direction: "output",
      purpose: "screenshot",
      byte_count: 4,
    }));
    expect(buildArtifactChunkParams(binding, 0, "AQIDBA==")).toEqual(expect.objectContaining({
      chunk_index: 0,
      data: "AQIDBA==",
    }));

    expect(parseArtifactAck({
      contract_version: 1,
      context_id: binding.contextId,
      browser_session_id: binding.browserSessionId,
      turn_id: binding.turnId,
      action_id: binding.actionId,
      op_id: binding.opId,
      artifact_id: binding.artifactId,
      direction: "output",
      purpose: "screenshot",
      phase: "chunk",
      status: "accepted",
      next_chunk_index: 1,
      received_bytes: 4,
    }, binding, "chunk")).toMatchObject({ nextChunkIndex: 1, receivedBytes: 4 });

    expect(() => parseArtifactAck({
      contract_version: 1,
      context_id: binding.contextId,
      browser_session_id: binding.browserSessionId,
      turn_id: binding.turnId,
      action_id: "different-action",
      op_id: binding.opId,
      artifact_id: binding.artifactId,
      direction: "output",
      purpose: "screenshot",
      phase: "chunk",
      status: "accepted",
      next_chunk_index: 1,
      received_bytes: 4,
    }, binding, "chunk")).toThrow(ArtifactSchemaError);
  });
});
