import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";

type ExtensionLaunch =
  | { kind: "ready"; context: BrowserContext; extensionId: string; close: () => Promise<void> }
  | { kind: "unavailable"; reason: string };

const extensionDirectory = path.resolve(import.meta.dirname, "../../dist");
const requiredBuildFiles = ["manifest.json", "options.html", "sidepanel.html"];
const removeProfile = (directory: string) => rm(directory, {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
});

function extensionIdFrom(worker: Worker): string {
  const url = new URL(worker.url());
  if (url.protocol !== "chrome-extension:" || !url.hostname) {
    throw new Error(`Expected an extension service worker URL, received ${worker.url()}`);
  }
  return url.hostname;
}

function browserUnavailableReason(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (/executable doesn't exist|browserType\.launchPersistentContext: Executable/i.test(message)) {
    return `Playwright Chromium is not installed: ${message.split("\n")[0]}`;
  }
  if (/extension.*not supported|disable-extensions-except.*not supported/i.test(message)) {
    return `This Playwright Chromium build cannot load unpacked extensions: ${message.split("\n")[0]}`;
  }
  return undefined;
}

export async function launchBuiltExtension(): Promise<ExtensionLaunch> {
  for (const file of requiredBuildFiles) {
    if (!existsSync(path.join(extensionDirectory, file))) {
      throw new Error(`Missing dist/${file}; run \`npm run build\` before the extension smoke test.`);
    }
  }

  const userDataDirectory = await mkdtemp(path.join(tmpdir(), "a0-extension-e2e-"));
  const headless = process.env.A0_EXTENSION_E2E_HEADLESS !== "0";
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(userDataDirectory, {
      channel: "chromium",
      headless,
      args: [
        `--disable-extensions-except=${extensionDirectory}`,
        `--load-extension=${extensionDirectory}`,
      ],
    });
  } catch (error) {
    await removeProfile(userDataDirectory);
    const reason = browserUnavailableReason(error);
    if (reason) return { kind: "unavailable", reason };
    throw error;
  }

  try {
    const existingWorker = context.serviceWorkers().find((worker) => worker.url().startsWith("chrome-extension://"));
    const worker = existingWorker ?? await context.waitForEvent("serviceworker", {
      predicate: (candidate) => candidate.url().startsWith("chrome-extension://"),
      timeout: 15_000,
    });
    const extensionId = extensionIdFrom(worker);

    return {
      kind: "ready",
      context,
      extensionId,
      close: async () => {
        await context.close();
        await removeProfile(userDataDirectory);
      },
    };
  } catch (error) {
    await context.close();
    await removeProfile(userDataDirectory);
    throw new Error(
      "Chromium launched but the unpacked Agent Zero extension did not register a service worker.",
      { cause: error },
    );
  }
}

export async function openExtensionPage(
  context: BrowserContext,
  extensionId: string,
  pageName: "options.html" | "sidepanel.html",
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${pageName}`);
  return page;
}
