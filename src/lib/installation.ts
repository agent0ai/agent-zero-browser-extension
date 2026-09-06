import installation from "../installation-platforms.json";

export type SetupPlatform = keyof typeof installation.platforms;
export const INSTALLATION = installation;

// Presentation only. Never selects a native binary or grants runtime authority.
// Unknown/mobile platforms require an explicit choice rather than assuming Mac.
export function suggestSetupPlatform(platform: string): SetupPlatform | "" {
  if (/android|iphone|ipad|cros/i.test(platform)) return "";
  if (/win/i.test(platform)) return "windows";
  if (/mac/i.test(platform)) return "macos";
  if (/linux|x11/i.test(platform)) return "linux";
  return "";
}
