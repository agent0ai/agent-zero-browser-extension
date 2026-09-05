import { describe, expect, it } from "vitest";

import {
  APPROVED_PRODUCTION_EXTENSION_IDS,
  extensionIdentityApproved,
} from "./release-trust";

describe("compiled extension release trust", () => {
  it("keeps development and same-name builds activation-blocked until release identity is reviewed", () => {
    expect(APPROVED_PRODUCTION_EXTENSION_IDS).toEqual([]);
    expect(extensionIdentityApproved("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
    expect(extensionIdentityApproved("not-an-extension-id")).toBe(false);
  });
});
