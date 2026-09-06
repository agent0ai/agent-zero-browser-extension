import { describe, expect, it } from "vitest";
import { INSTALLATION, suggestSetupPlatform } from "./installation";

describe("platform setup presentation", () => {
  it.each([["Win32", "windows"], ["MacIntel", "macos"], ["Linux x86_64", "linux"],
    ["Linux aarch64", "linux"], ["Android Linux", ""], ["CrOS x86_64", ""], ["iPad", ""], ["", ""]])(
    "suggests an editable platform for %s", (input, expected) => expect(suggestSetupPlatform(input)).toBe(expected),
  );
  it("does not advertise unreleased native installers or Mac downloads for other systems", () => {
    for (const platform of ["windows", "linux"] as const) {
      expect(INSTALLATION.platforms[platform].available).toBe(false);
      expect(INSTALLATION.platforms[platform].download_url).toBeNull();
    }
    expect(INSTALLATION.platforms.macos.download_url).toContain("/native-v2.12.3-macos/");
  });
});
