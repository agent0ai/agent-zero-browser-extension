import { describe, expect, it } from "vitest";
import { consumeInputArtifactPath, inputArtifactParams, parseInputArtifact } from "./input-artifact";

describe("private input artifact authority", () => {
  it("admits native local-drive paths but rejects Windows network/device/stream aliases", () => {
    const binding = { contextId: "c", browserSessionId: "s", turnId: "t", actionId: "a", opId: "o", artifactId: "f" };
    const value = { ...inputArtifactParams(binding), descriptor: {
      artifact_id: "f", mime_type: "text/plain", byte_count: 3, sha256: `sha256:${"a".repeat(64)}`, purpose: "upload_file",
    } };
    const local = String.raw`C:\Users\Local User\A0\input.txt`;
    expect(consumeInputArtifactPath(parseInputArtifact({ ...value, ephemeral_path: local }, binding), "a")).toBe(local);
    for (const path of [String.raw`\\host\share\file`, String.raw`\\?\C:\file`, String.raw`\\.\pipe\name`,
      String.raw`C:\input.txt:secret`, String.raw`C:\..\file`, String.raw`C:\A0\NUL`, String.raw`C:\A0\file.`,
      "C:relative", "C:/file", "/private/../file", "//host/file", "/private//file"]) {
      expect(() => parseInputArtifact({ ...value, ephemeral_path: path }, binding)).toThrow();
    }
  });
  it("requires the exact route and only permits one opaque-object consumption", () => {
    const binding = { contextId: "c", browserSessionId: "s", turnId: "t", actionId: "a", opId: "o", artifactId: "f" };
    const value = { ...inputArtifactParams(binding), ephemeral_path: "/private/a0-input", descriptor: {
      artifact_id: "f", mime_type: "text/plain", byte_count: 3, sha256: `sha256:${"a".repeat(64)}`, purpose: "upload_file",
    } };
    expect(() => parseInputArtifact({ ...value, op_id: "replacement" }, binding)).toThrow();
    const verified = parseInputArtifact(value, binding);
    expect(JSON.stringify(verified)).not.toContain(value.ephemeral_path);
    expect(() => consumeInputArtifactPath({ ...verified }, "a")).toThrow();
    expect(() => consumeInputArtifactPath(verified, "other")).toThrow();
    expect(consumeInputArtifactPath(verified, "a")).toBe(value.ephemeral_path);
    expect(() => consumeInputArtifactPath(verified, "a")).toThrow();
  });
});
