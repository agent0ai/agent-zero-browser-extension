import { createHash, createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildChannelForMode, DEVELOPMENT_EXTENSION_ID, DEVELOPMENT_MANIFEST_KEY } from "./build-channel";
import { extensionIdentityApproved } from "./background/release-trust";

describe("local development build identity", () => {
  it("derives the pinned extension identity from a valid public manifest key", () => {
    const der = Buffer.from(DEVELOPMENT_MANIFEST_KEY, "base64");
    expect(createPublicKey({ key: der, format: "der", type: "spki" }).asymmetricKeyType).toBe("rsa");
    const identity = createHash("sha256").update(der).digest("hex").slice(0, 32)
      .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
    expect(identity).toBe(DEVELOPMENT_EXTENSION_ID);
    expect(extensionIdentityApproved(identity)).toBe(false);
  });

  it("isolates development host and output while default modes retain production routing", () => {
    const dev = buildChannelForMode("local-development");
    const production = buildChannelForMode("production");
    expect(dev.nativeHostName).toBe("io.agentzero.browser_bridge.dev");
    expect(dev.outDir).toBe("dist-development");
    expect(dev.extensionName).toBe("Agent Zero Chrome Bridge (Development)");
    expect(production.nativeHostName).toBe("io.agentzero.browser_bridge");
    expect(production.outDir).toBe("dist");
    expect(buildChannelForMode("development")).toEqual(production);
    expect(buildChannelForMode("test")).toEqual(production);
  });
});
