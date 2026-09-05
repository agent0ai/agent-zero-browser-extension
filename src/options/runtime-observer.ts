import { connectSidePanelPort } from "../lib/extension";
import { parseRuntimePresentation, type RuntimePresentation } from "../lib/runtime-presentation";

// Presentation-only subscription, owned by the options page's mounted lifetime.
// Worker push messages outrank any request snapshot captured before that push.
export function observeOptionsRuntime(
  onState: (state: RuntimePresentation) => void,
  onDisconnected: () => void,
  connect: () => chrome.runtime.Port = connectSidePanelPort,
) {
  const port = connect();
  let active = true;
  let connected = true;
  let revision = 0;
  const receive = (message: unknown) => {
    if (!active || !connected || typeof message !== "object" || message === null) return;
    const value = message as Record<string, unknown>;
    if (value.type !== "state") return;
    revision += 1;
    onState(parseRuntimePresentation(value.state));
  };
  const disconnected = () => {
    if (!active || !connected) return;
    connected = false;
    revision += 1;
    port.onMessage.removeListener(receive);
    port.onDisconnect.removeListener(disconnected);
    onDisconnected();
  };
  port.onMessage.addListener(receive);
  port.onDisconnect.addListener(disconnected);
  return {
    get active() { return active; },
    get connected() { return connected; },
    capture: () => revision,
    isCurrent: (captured: number) => active && connected && captured === revision,
    applyResponse(captured: number, value: unknown) {
      if (!active || !connected || captured !== revision) return false;
      revision += 1;
      onState(parseRuntimePresentation(value));
      return true;
    },
    close() {
      if (!active) return;
      active = false;
      connected = false;
      revision += 1;
      port.onMessage.removeListener(receive);
      port.onDisconnect.removeListener(disconnected);
      try { port.disconnect(); } catch { /* The worker may already be gone. */ }
    },
  };
}
