// Selected by Vite at build time. No preference, storage, or runtime environment
// can turn a production artifact into a development installation.
declare const __A0_LOCAL_DEVELOPMENT__: boolean;

export const DEVELOPMENT_EXTENSION_ID = "paoagmddepkmonpeboobaijlenlcokpc";
export const DEVELOPMENT_TRUST_CONTRACT = "a0.browser-bridge.development-trust.v1";
export const DEVELOPMENT_CHANNEL = "local-development";
export const DEVELOPMENT_MANIFEST_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlYUi9GoonJY2DmyIMsQCDPm9tPVjv83GLs/ONvCSpawxGgeYxaOIUmD0XazsuPW9ofV7fC0DpYzFpSpxWalGVZg+efceTIKG5YIwmM65Vz2NH1vHw8ViybTaAJfqFK0aZIbAupppcVFV7g2sjk1S08pGxV7tQsMbUq+TOPDPAuxnHKkW0GCyPI+BmHGnz/UQMWGbyvxYcGt20Ifccl1OsQOK+GjvOb0F7r6GW2vhQ/1vFY/mpCl6Kcep+ZW/UczAiMfJAQdEzqTwlz7gZU7rhd2m/nAMlvKhwjJzfXaH2kcuEDB2MqaJ0WQCjmKiDGbdNcGwW8KS9lpxEojQ8cVQ0wIDAQAB";

export function buildChannelForMode(mode: string) {
  const development = mode === DEVELOPMENT_CHANNEL;
  return {
    development,
    nativeHostName: development ? "io.agentzero.browser_bridge.dev" : "io.agentzero.browser_bridge",
    extensionName: development ? "Agent Zero Chrome Bridge (Development)" : "Agent Zero Chrome Bridge",
    label: development ? "Local development" : "",
    outDir: development ? "dist-development" : "dist",
  } as const;
}

export const BUILD_CHANNEL = buildChannelForMode(
  typeof __A0_LOCAL_DEVELOPMENT__ !== "undefined" && __A0_LOCAL_DEVELOPMENT__
    ? "local-development"
    : "production",
);
