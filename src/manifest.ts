import { defineManifest } from "@crxjs/vite-plugin";
import { buildChannelForMode, DEVELOPMENT_MANIFEST_KEY } from "./build-channel";
import productionIdentity from "./production-identity.json";

export function createManifest(mode = "production") {
  const channel = buildChannelForMode(mode);
  return defineManifest({
  manifest_version: 3,
  minimum_chrome_version: "120",
  name: channel.extensionName,
  key: channel.development ? DEVELOPMENT_MANIFEST_KEY : productionIdentity.manifest_public_key,
  version: "0.1.1",
  description: "Agent Zero side panel and user-visible browser task runtime.",
  permissions: [
    "alarms",
    "contextMenus",
    "debugger",
    "nativeMessaging",
    "scripting",
    "sidePanel",
    "storage",
    "tabGroups",
    "tabs",
  ],
  host_permissions: ["http://*/*", "https://*/*"],
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  icons: {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png",
  },
  action: {
    default_title: channel.development ? "Open Agent Zero (Development)" : "Open Agent Zero",
    default_icon: {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png",
    },
  },
  side_panel: {
    default_path: "sidepanel.html",
  },
  commands: {
    "open-agent-zero": {
      description: "Open Agent Zero for the current tab",
    },
  },
  options_page: "options.html",
  });
}

export default createManifest();
