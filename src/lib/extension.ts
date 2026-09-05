export async function sendRuntimeMessage<T>(message: Record<string, unknown>): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      if (response && typeof response === "object" && "ok" in response && response.ok === false) {
        const messageText =
          "error" in response && typeof response.error === "string" && response.error
            ? response.error
            : "The extension request failed.";
        reject(new Error(messageText));
        return;
      }

      resolve(response as T);
    });
  });
}

export function connectSidePanelPort(): chrome.runtime.Port {
  return chrome.runtime.connect({ name: "a0.browser-bridge.side-panel.v1" });
}

export async function sendSidePanelRequest<T>(
  port: chrome.runtime.Port,
  request: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<T> {
  const requestId = `ui:${crypto.randomUUID()}`;
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("CONTEXT_REQUEST_TIMEOUT"));
    }, timeoutMs);
    const onDisconnect = () => {
      cleanup();
      reject(new Error("CONTEXT_RELAY_INACTIVE"));
    };
    const onMessage = (value: unknown) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return;
      const message = value as Record<string, unknown>;
      if (message.type !== "ui_response" || message.request_id !== requestId) return;
      cleanup();
      const response = message.response;
      if (typeof response !== "object" || response === null || Array.isArray(response)) {
        reject(new Error("CONTEXT_RESPONSE_INVALID"));
        return;
      }
      const result = response as Record<string, unknown>;
      if (result.ok !== true) {
        const code = typeof result.error === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(result.error)
          ? result.error
          : "CONTEXT_REQUEST_FAILED";
        reject(new Error(code));
        return;
      }
      resolve(result as T);
    };
    const cleanup = () => {
      clearTimeout(timer);
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    try {
      port.postMessage({ type: "ui_request", request_id: requestId, request });
    } catch {
      cleanup();
      reject(new Error("CONTEXT_RELAY_INACTIVE"));
    }
  });
}
