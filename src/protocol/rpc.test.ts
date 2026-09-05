import { describe, expect, it } from "vitest";

import {
  MAX_DIAGNOSTIC_LENGTH,
  MAX_NATIVE_MESSAGE_BYTES,
  MAX_NON_ARTIFACT_BYTES,
  RpcValidationError,
  parseRpcMessage,
  rpcError,
  rpcResult,
} from "./rpc";

const expectRpcReason = (message: unknown, reasonCode: RpcValidationError["reasonCode"]): void => {
  try {
    parseRpcMessage(message);
  } catch (error) {
    expect(error).toBeInstanceOf(RpcValidationError);
    expect((error as RpcValidationError).reasonCode).toBe(reasonCode);
    return;
  }
  throw new Error(`Expected RPC validation to fail with ${reasonCode}`);
};

describe("native JSON-RPC validation", () => {
  it("accepts one allowlisted object request", () => {
    expect(
      parseRpcMessage({
        jsonrpc: "2.0",
        id: "request-1",
        method: "browser.perform",
        params: { contract_version: 1 },
      }),
    ).toEqual({
      jsonrpc: "2.0",
      id: "request-1",
      method: "browser.perform",
      params: { contract_version: 1 },
    });
  });

  it("ignores additive optional envelope and error fields", () => {
    expect(parseRpcMessage({
      jsonrpc: "2.0",
      id: "request-optional",
      method: "bridge.ping",
      params: {},
      future_hint: "ignored",
    })).toEqual({ jsonrpc: "2.0", id: "request-optional", method: "bridge.ping", params: {} });
    expect(parseRpcMessage({
      jsonrpc: "2.0",
      id: "response-optional",
      error: { code: -32010, message: "Blocked", future_hint: "ignored" },
      future_hint: "ignored",
    })).toEqual({
      jsonrpc: "2.0",
      id: "response-optional",
      error: { code: -32010, message: "Blocked" },
    });
  });

  it.each([
    [[], "MESSAGE_NOT_OBJECT"],
    [{ jsonrpc: "2.0", id: "x", method: "Browser.Perform", params: {} }, "UNKNOWN_METHOD"],
    [{ jsonrpc: "2.0", id: 3, method: "bridge.ping", params: {} }, "INVALID_ID"],
    [{ jsonrpc: "2.0", id: "x", method: "bridge.ping", params: [] }, "INVALID_PARAMS"],
    [{ jsonrpc: "2.0", id: "x", method: "bridge.ping", params: {}, result: {} }, "INVALID_PARAMS"],
    [{ jsonrpc: "2.0", id: "x", params: {}, result: {} }, "INVALID_RESPONSE"],
    [{ jsonrpc: "2.0", id: "x", result: {}, error: { code: -1, message: "bad" } }, "INVALID_RESPONSE"],
  ])("rejects malformed or batched input %#", (message, code) => {
    expectRpcReason(message, code as RpcValidationError["reasonCode"]);
  });

  it("rejects oversized messages before dispatch", () => {
    const message = {
      jsonrpc: "2.0",
      id: "request-1",
      method: "bridge.ping",
      params: { value: "x".repeat(MAX_NATIVE_MESSAGE_BYTES) },
    };
    expectRpcReason(message, "MESSAGE_TOO_LARGE");
  });

  it("rejects responses above the frozen non-artifact limit", () => {
    expectRpcReason({
      jsonrpc: "2.0",
      id: "request-1",
      result: { value: "x".repeat(MAX_NON_ARTIFACT_BYTES) },
    }, "INVALID_RESPONSE");
    expect(() => rpcResult("request-1", { value: "x".repeat(MAX_NON_ARTIFACT_BYTES) })).toThrowError(
      expect.objectContaining({ reasonCode: "MESSAGE_TOO_LARGE" }),
    );
  });

  it("builds exact result and error envelopes", () => {
    expect(rpcResult("one", { ok: true })).toEqual({
      jsonrpc: "2.0",
      id: "one",
      result: { ok: true },
    });
    expect(rpcError("two", -32010, "Blocked", { a0_code: "INVALID_STATE" })).toEqual({
      jsonrpc: "2.0",
      id: "two",
      error: {
        code: -32010,
        message: "Blocked",
        data: { a0_code: "INVALID_STATE" },
      },
    });
  });

  it("accepts the frozen correlation and diagnostic bounds", () => {
    const id = `a${"1".repeat(255)}`;
    expect(parseRpcMessage({ jsonrpc: "2.0", id, result: {} })).toEqual({ jsonrpc: "2.0", id, result: {} });
    expect(parseRpcMessage({
      jsonrpc: "2.0",
      id: "bounded-error",
      error: { code: -32010, message: "x".repeat(MAX_DIAGNOSTIC_LENGTH) },
    })).toEqual(expect.objectContaining({ id: "bounded-error" }));
  });
});
