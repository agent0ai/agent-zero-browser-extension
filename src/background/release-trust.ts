const EXTENSION_ID = /^[a-p]{32}$/u;

// Populated only by a reviewed production release. An unpacked build or an
// arbitrary extension with the same native-host name must remain pairing-only.
export const APPROVED_PRODUCTION_EXTENSION_IDS: readonly string[] = Object.freeze([]);

export function extensionIdentityApproved(extensionId: unknown): boolean {
  return typeof extensionId === "string"
    && EXTENSION_ID.test(extensionId)
    && APPROVED_PRODUCTION_EXTENSION_IDS.includes(extensionId);
}
