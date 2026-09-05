import { hasExactKeys, isRecord, validOpaqueId } from "./rpc";

export type CredentialAction = "rotate" | "status" | "revoke";
export interface CredentialStatus extends Record<string, unknown> {
  contract_version: 1;
  action: CredentialAction;
  rotation_id: string | null;
  key_generation: number;
  status: "pending" | "active" | "expired" | "revoked";
  expires_at_ms: number | null;
}

export function parseCredentialStatus(value: unknown, expectedAction?: CredentialAction): CredentialStatus {
  if (!isRecord(value) || !hasExactKeys(value, ["contract_version", "action", "rotation_id", "key_generation", "status", "expires_at_ms"])
    || value.contract_version !== 1 || !["rotate", "status", "revoke"].includes(String(value.action))
    || (expectedAction && value.action !== expectedAction)
    || !Number.isSafeInteger(value.key_generation) || Number(value.key_generation) < 1 || Number(value.key_generation) > 2_147_483_647) throw new Error("Invalid credential response");
  if (value.action === "revoke") {
    if (value.status !== "revoked" || value.rotation_id !== null || value.expires_at_ms !== null) throw new Error("Invalid credential response");
  } else if (!validOpaqueId(value.rotation_id) || !["pending", "active", "expired"].includes(String(value.status))
    || (value.status === "pending" ? !Number.isSafeInteger(value.expires_at_ms) || Number(value.expires_at_ms) < 0 : value.expires_at_ms !== null)) throw new Error("Invalid credential response");
  return value as CredentialStatus;
}
