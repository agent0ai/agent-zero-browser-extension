import productionIdentity from "../production-identity.json";

const EXTENSION_ID = /^[a-p]{32}$/u;

// Owner-supplied store draft identity, verified against its public package key.
// Identity recognition alone never grants runtime admission or release trust.
export const APPROVED_PRODUCTION_EXTENSION_IDS: readonly string[] = Object.freeze([productionIdentity.extension_id]);

export function extensionIdentityApproved(extensionId: unknown): boolean {
  return typeof extensionId === "string"
    && EXTENSION_ID.test(extensionId)
    && APPROVED_PRODUCTION_EXTENSION_IDS.includes(extensionId);
}
