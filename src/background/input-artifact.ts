import { hasExactKeys, isRecord, validOpaqueId } from "../protocol/rpc";
import { NativeRequestError } from "./native-port";

export interface InputArtifactBinding {
  contextId: string;
  browserSessionId: string;
  turnId: string;
  actionId: string;
  opId: string;
  artifactId: string;
}

export interface InputArtifactDescriptor {
  artifact_id: string;
  mime_type: string;
  byte_count: number;
  sha256: string;
  purpose: "upload_file";
}

export interface VerifiedInputArtifact {
  readonly binding: Readonly<InputArtifactBinding>;
  readonly descriptor: Readonly<InputArtifactDescriptor>;
}

// Paths never enter object projections, storage, log/result JSON or UI state.
// Only a parser-produced object from the current native response can consume one.
const paths = new WeakMap<VerifiedInputArtifact, string>();

function localArtifactPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  if (value.startsWith("/") && !value.startsWith("//")) {
    return value.slice(1).split("/").every((part) => part !== "" && part !== "." && part !== "..");
  }
  // The native Windows spool emits a normal absolute local-drive path only.
  // Never admit network/device namespaces, alternate streams or traversal.
  return /^[a-z]:\\/iu.test(value) && !/[/:*?"<>|]/u.test(value.slice(3))
    && value.slice(3).split("\\").every((part) => part !== "" && part !== "." && part !== ".."
      && !/[. ]$/u.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part));
}

export function inputArtifactParams(binding: InputArtifactBinding): Record<string, unknown> {
  if (!Object.values(binding).every((value) => validOpaqueId(value))) throw new NativeRequestError("Invalid input artifact binding.", "INVALID_STATE");
  return {
    contract_version: 1, context_id: binding.contextId, browser_session_id: binding.browserSessionId,
    turn_id: binding.turnId, action_id: binding.actionId, op_id: binding.opId,
    artifact_id: binding.artifactId, direction: "input", purpose: "upload_file",
  };
}

export function parseInputArtifact(value: unknown, binding: InputArtifactBinding): VerifiedInputArtifact {
  const expected = inputArtifactParams(binding);
  const invalid = () => new NativeRequestError("The native input artifact did not match this exact operation.", "INVALID_STATE");
  if (!isRecord(value) || !hasExactKeys(value, [...Object.keys(expected), "descriptor", "ephemeral_path"])
    || Object.entries(expected).some(([key, entry]) => value[key] !== entry)
    || !localArtifactPath(value.ephemeral_path)
    || !isRecord(value.descriptor)
    || !hasExactKeys(value.descriptor, ["artifact_id", "mime_type", "byte_count", "sha256", "purpose"])) throw invalid();
  const descriptor = value.descriptor;
  if (descriptor.artifact_id !== binding.artifactId || descriptor.purpose !== "upload_file"
    || typeof descriptor.mime_type !== "string" || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(descriptor.mime_type)
    || descriptor.mime_type.length > 255 || !Number.isSafeInteger(descriptor.byte_count)
    || Number(descriptor.byte_count) < 1 || Number(descriptor.byte_count) > 25 * 1024 * 1024
    || typeof descriptor.sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(descriptor.sha256)) throw invalid();
  const verified = Object.freeze({
    binding: Object.freeze({ ...binding }),
    descriptor: Object.freeze({ ...descriptor }) as Readonly<InputArtifactDescriptor>,
  });
  paths.set(verified, value.ephemeral_path);
  return verified;
}

export function consumeInputArtifactPath(value: VerifiedInputArtifact, actionId: string): string {
  const path = paths.get(value);
  if (!path || value.binding.actionId !== actionId) throw new NativeRequestError("Input artifact authority is unavailable.", "INVALID_STATE");
  paths.delete(value);
  return path;
}
