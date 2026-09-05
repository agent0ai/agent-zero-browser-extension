import { expect, test } from "@playwright/test";

import { launchBuiltExtension, openExtensionPage } from "./extension-harness";

test("the built extension exposes setup, pairing, and activation-pending surfaces", async () => {
  const launched = await launchBuiltExtension();
  test.skip(launched.kind === "unavailable", launched.kind === "unavailable" ? launched.reason : "");
  if (launched.kind === "unavailable") return;

  const { context, extensionId } = launched;
  try {
    expect(extensionId).toMatch(/^[a-p]{32}$/);

    const options = await openExtensionPage(context, extensionId, "options.html");
    await expect(options).toHaveTitle("Agent Zero Options");
    await expect(options.getByRole("heading", { name: "Chrome connection" })).toBeVisible();
    await expect(options.getByRole("heading", { name: "Pair this Chrome profile" })).toBeVisible();
    await expect(options.getByLabel("Agent Zero address")).toHaveAttribute("placeholder", "http://localhost:50080");
    await expect(options.getByLabel("Pairing code")).toHaveAttribute("placeholder", "A0B1-…");
    await expect(options.getByText("a0 browser-extension install", { exact: true })).toBeVisible();
    await expect(options.getByRole("heading", { name: "Keep the bridge on the host" })).toBeVisible();
    await expect(options.getByRole("heading", { name: "No extension API key" })).toBeVisible();
    await expect(options.locator('input[type="password"]')).toHaveCount(0);
    await expect(options.locator('input[name*="api" i], input[id*="api" i]')).toHaveCount(0);
    await expect(options.getByLabel(/api key|access token|bearer token/i)).toHaveCount(0);

    const sidePanel = await openExtensionPage(context, extensionId, "sidepanel.html");
    await expect(sidePanel).toHaveTitle("Agent Zero");
    await expect(sidePanel.getByText("Browser workspace", { exact: true })).toBeVisible();
    await expect(sidePanel.getByText("Closing this panel never stops browser work or closes task tabs.")).toBeVisible();
    await expect(sidePanel.getByRole("button", { name: "Open browser connection settings" })).toBeVisible();

    const activationPending = await context.newPage();
    await activationPending.addInitScript(({ state }) => {
      const runtime = globalThis.chrome?.runtime;
      if (!runtime) throw new Error("Chrome extension runtime was not installed in the extension page.");

      runtime.sendMessage = ((_message: unknown, callback?: (response: unknown) => void) => {
        queueMicrotask(() => callback?.({ ok: true, state }));
      }) as typeof runtime.sendMessage;
    }, {
      state: {
        ready: false,
        connectionError: "",
        lastStatus: "Paired; activation gates remain closed",
        bridge: {
          contract: "a0.browser-bridge.mv3-runtime.v1",
          phase: "READY",
          connection: {
            state: "ready",
            reasonCode: "activation_pending",
            serverState: "paired_inactive",
            reportedServerState: "paired",
            activationReady: false,
            activationBlockers: ["extension_identity_unapproved"],
            negotiatedActions: [],
            negotiatedFeatures: ["tab_leases_v1", "tab_groups_v1"],
          },
          capabilities: ["tab_leases_v1", "tab_groups_v1"],
          actions: [],
          activeLeaseCount: 0,
          candidateReady: false,
        },
      },
    });
    await activationPending.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(activationPending.getByText("Activation pending", { exact: true })).toBeVisible();
    await expect(activationPending.getByRole("heading", { name: "This profile knows its Agent Zero companion" })).toBeVisible();
    await expect(activationPending.getByText("The identity is paired, but browser control stays off until every activation gate validates.")).toBeVisible();
    await activationPending.getByText("Technical diagnostics", { exact: true }).click();
    await expect(activationPending.getByText("extension_identity_unapproved", { exact: true })).toBeVisible();
    await expect(activationPending.getByLabel("Pairing code")).toHaveCount(0);
  } finally {
    await launched.close();
  }
});
