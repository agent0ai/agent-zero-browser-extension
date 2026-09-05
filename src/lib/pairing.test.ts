import { describe, expect, it } from "vitest";

import { PairingInputError, parsePairingSubmission } from "./pairing";

function expectPairingError(run: () => unknown, reasonCode: PairingInputError["reasonCode"]): void {
  try {
    run();
    throw new Error("Expected pairing validation to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(PairingInputError);
    expect((error as PairingInputError).reasonCode).toBe(reasonCode);
  }
}

describe("pairing submission", () => {
  it("normalizes a loopback Docker origin without weakening the protected exchange", () => {
    expect(parsePairingSubmission(
      " http://localhost:50080/a0/ ",
      "a0b1-deadbeef-0123456789abcdefghjkmnpqrstvwxyz",
    )).toEqual({
      contract_version: 1,
      server_base_url: "http://localhost:50080/a0",
      pairing_code: "A0B1-DEADBEEF-0123456789ABCDEFGHJKMNPQRSTVWXYZ",
    });
  });

  it("accepts HTTPS and IPv4 or IPv6 loopback but rejects non-loopback HTTP", () => {
    expect(parsePairingSubmission("https://agent.example.test", "A0B1-DEADBEEF-0123456789ABCDEFGHJKMNPQRSTVWXYZ").server_base_url)
      .toBe("https://agent.example.test");
    expect(parsePairingSubmission("http://127.9.8.7:50080", "A0B1-DEADBEEF-01234567-89ABCDEF-GHJKMNPQ-RSTVWXYZ").server_base_url)
      .toBe("http://127.9.8.7:50080");
    expect(parsePairingSubmission("http://[::1]:50080", "A0B1-DEADBEEF-0123456789ABCDEFGHJKMNPQRSTVWXYZ").server_base_url)
      .toBe("http://[::1]:50080");
    expect(parsePairingSubmission("http://agent.localhost:50080/a0", "A0B1-DEADBEEF-0123456789ABCDEFGHJKMNPQRSTVWXYZ").server_base_url)
      .toBe("http://agent.localhost:50080/a0");
    expectPairingError(
      () => parsePairingSubmission("http://agent.example.test", "A0B1-DEADBEEF-0123456789ABCDEFGHJKMNPQRSTVWXYZ"),
      "INSECURE_SERVER_URL",
    );
  });

  it("rejects credentials, query data, fragments, and malformed codes", () => {
    for (const value of [
      "https://user:secret@agent.example.test",
      "https://agent.example.test?code=secret",
      "https://agent.example.test/#secret",
      "https://agent.example.test/a//b",
      "https://agent.example.test/a/%62",
      "https://agent.example.test/a/../b",
    ]) {
      expectPairingError(
        () => parsePairingSubmission(value, "A0B1-DEADBEEF-0123456789ABCDEFGHJKMNPQRSTVWXYZ"),
        "INVALID_SERVER_URL",
      );
    }
    expectPairingError(
      () => parsePairingSubmission("https://agent.example.test", "not-a-pairing-code"),
      "INVALID_PAIRING_CODE",
    );
    expectPairingError(
      () => parsePairingSubmission("https://agent.example.test", "A0B1-AB12-ABCDEFGH"),
      "INVALID_PAIRING_CODE",
    );
  });
});
