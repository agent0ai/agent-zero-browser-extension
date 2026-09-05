import { describe, expect, it, vi } from "vitest";

vi.mock("../build-channel", async (importOriginal) => {
  const original = await importOriginal<typeof import("../build-channel")>();
  return { ...original, BUILD_CHANNEL: original.buildChannelForMode("local-development") };
});

import { DEVELOPMENT_EXTENSION_ID } from "../build-channel";
import {
  buildPairingExchangeParams, evaluateActivation, MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_CHUNK_BYTES, parseHelloResult, parsePairingExchangeResult,
  parsePairingStatusResult, REQUIRED_BRIDGE_SCOPES,
} from "./native";
import { MAX_NATIVE_MESSAGE_BYTES } from "./rpc";

const development = {
  contract: "a0.browser-bridge.development-trust.v1",
  channel: "local-development",
  connector_session_ready: false,
  browser_control_ready: false,
  reason_code: "development_runtime_not_available",
};
const hello = () => ({
  protocol: "a0.browser-bridge.v1", contract_version: 1, connection_id: "connection-one",
  companion: { instance_id: "companion-one", version: "0.1.0", platform: "darwin", arch: "arm64" },
  server: { state: "unpaired", instance_id: null, label: "Agent Zero" },
  limits: { max_json_frame_bytes: MAX_NATIVE_MESSAGE_BYTES, artifact_chunk_bytes: MAX_ARTIFACT_CHUNK_BYTES, max_artifact_bytes: MAX_ARTIFACT_BYTES },
  negotiated: { actions: [], features: [] }, development,
});
const status = () => ({
  contract_version: 1, state: "unpaired", server: null,
  companion: { version: "0.1.0" }, diagnostics: [], development,
});
const exchange = () => ({
  contract_version: 1, state: "paired", bridge_id: "bridge-one",
  server: { instance_id: "server-one", label: "Agent Zero", base_origin: "http://localhost:50080" },
  scopes: [...REQUIRED_BRIDGE_SCOPES], policy: { mode: "ask_per_site", ready: false }, development,
});

describe("compiled development pairing-only protocol", () => {
  it("requires the exact false-readiness envelope on hello, status, and exchange", () => {
    expect(parseHelloResult(hello()).development).toEqual(development);
    expect(parsePairingStatusResult(status()).development).toEqual(development);
    expect(parsePairingExchangeResult(exchange()).development).toEqual(development);
    for (const invalid of [
      undefined, { ...development, channel: "production" },
      { ...development, connector_session_ready: true },
      { ...development, browser_control_ready: true },
      { ...development, reason_code: "ready" },
      { ...development, extra: false },
      { contract: development.contract, channel: development.channel },
    ]) {
      expect(() => parseHelloResult({ ...hello(), development: invalid })).toThrow("HELLO_DEVELOPMENT_INVALID");
      expect(() => parsePairingStatusResult({ ...status(), development: invalid })).toThrow("PAIRING_DEVELOPMENT_INVALID");
      expect(() => parsePairingExchangeResult({ ...exchange(), development: invalid })).toThrow("PAIRING_DEVELOPMENT_INVALID");
    }
  });

  it("cannot activate from development pairing or accept a ready policy", () => {
    const parsed = parseHelloResult({ ...hello(), server: { state: "paired", instance_id: "server-one", label: "Agent Zero" } });
    const result = evaluateActivation(parsed, {
      extensionIdentityApproved: true, storageMigrationState: "v1_ready",
      chromePermissionsReady: true, legacyControlPlaneInactive: true, operationalMethodSurfaceReady: true,
    }, { extensionId: DEVELOPMENT_EXTENSION_ID, installInstanceId: "install-one", actions: [], features: [] });
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain("development_runtime_not_available");
    expect(() => parseHelloResult({ ...hello(), activation: {} })).toThrow("HELLO_DEVELOPMENT_INVALID");
    expect(() => parsePairingExchangeResult({ ...exchange(), policy: { mode: "ask_per_site", ready: true } })).toThrow("PAIRING_EXCHANGE_INVALID");
  });

  it("retains the frozen native request; the compiled native host selects the development HTTP route", () => {
    expect(buildPairingExchangeParams({ pairingCode: "A0B1-DEADBEEF-0123456789ABCDEFGHJKMNPQRSTVWXYZ", serverBaseOrigin: "http://localhost:50080" })).toEqual({
      contract_version: 1, pairing_code: "A0B1-DEADBEEF-0123456789ABCDEFGHJKMNPQRSTVWXYZ", server_base_origin: "http://localhost:50080",
    });
  });
});
