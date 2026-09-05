import { describe, expect, it } from "vitest";
import { parseCredentialStatus } from "./credentials";
import fixture from "./fixtures/credential-control-v1.json";

describe("credential receipts", () => {
  const pending = { contract_version: 1, action: "rotate", rotation_id: "rotation-1", key_generation: 1, status: "pending", expires_at_ms: 1000 };
  it("accepts only bounded typed Core status without private material", () => {
    expect(parseCredentialStatus(pending, "rotate").status).toBe("pending");
    expect(() => parseCredentialStatus({ ...pending, private_seed: "never" })).toThrow();
    expect(() => parseCredentialStatus({ ...pending, key_generation: 2147483648 })).toThrow();
    expect(() => parseCredentialStatus(pending, "revoke")).toThrow();
    expect(() => parseCredentialStatus({ ...pending, status: "active" })).toThrow();
  });
  it("requires a definitive revoke receipt", () => {
    for (const action of ["rotate", "status", "revoke"] as const) expect(parseCredentialStatus(fixture[action].response, action).action).toBe(action);
    expect(parseCredentialStatus({ ...pending, action: "revoke", rotation_id: null, status: "revoked", expires_at_ms: null }, "revoke").status).toBe("revoked");
    expect(() => parseCredentialStatus({ ...pending, action: "revoke", status: "revoked" })).toThrow();
  });
});
