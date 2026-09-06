import { describe, expect, it } from "vitest";
import productionIdentity from "../production-identity.json";
import { DEVELOPMENT_EXTENSION_ID } from "../build-channel";

import {
  APPROVED_PRODUCTION_EXTENSION_IDS,
  extensionIdentityApproved,
} from "./release-trust";

describe("compiled extension release trust", () => {
  it("recognizes only the verified store identity, never development or same-name builds", () => {
    expect(APPROVED_PRODUCTION_EXTENSION_IDS).toEqual([productionIdentity.extension_id]);
    expect(extensionIdentityApproved(productionIdentity.extension_id)).toBe(true);
    expect(extensionIdentityApproved(DEVELOPMENT_EXTENSION_ID)).toBe(false);
    expect(extensionIdentityApproved("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
    expect(extensionIdentityApproved("not-an-extension-id")).toBe(false);
  });
});
