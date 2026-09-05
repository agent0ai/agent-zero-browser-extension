import { parsePairingSubmission, type PairingSubmission } from "../lib/pairing";
import {
  buildContextSendMessageParams,
  buildContextSubscribeParams,
  buildContextUnsubscribeParams,
  type ContextSendMessageResult,
  type ContextSubscribeInput,
} from "../protocol/context";
import type { ContextPanelView } from "./context-relay";

export class UiRequestError extends Error {
  constructor(
    public readonly reasonCode: "INVALID_UI_REQUEST" | "UNSUPPORTED_UI_REQUEST",
  ) {
    super(reasonCode);
  }
}

export interface UiRouterDependencies {
  getState: () => Record<string, unknown>;
  refresh: () => Promise<Record<string, unknown>>;
  reconnectDevelopmentBrowser?: () => Promise<Record<string, unknown>>;
  pair: (submission: PairingSubmission) => Promise<Record<string, unknown>>;
  disconnect: () => Promise<Record<string, unknown>>;
  contextList: (panelId: string) => Promise<ContextPanelView>;
  contextSubscribe: (panelId: string, input: ContextSubscribeInput) => Promise<ContextPanelView>;
  contextUnsubscribe: (panelId: string, contextId: string) => Promise<ContextPanelView>;
  contextSendMessage: (
    panelId: string,
    input: { contextId: string; clientMessageId: string; text: string },
  ) => Promise<ContextSendMessageResult>;
}

export interface UiRouteContext {
  panelId: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const actual = Object.keys(value);
  const allowed = new Set([...keys, ...optional]);
  return keys.every((key) => Object.hasOwn(value, key)) && actual.every((key) => allowed.has(key));
}

export function createUiRouter(dependencies: UiRouterDependencies) {
  return async (message: unknown, routeContext?: UiRouteContext): Promise<Record<string, unknown>> => {
    if (!isRecord(message) || typeof message.type !== "string") {
      throw new UiRequestError("INVALID_UI_REQUEST");
    }

    switch (message.type) {
      case "get_state":
        if (!hasExactKeys(message, ["type"])) throw new UiRequestError("INVALID_UI_REQUEST");
        return { ok: true, state: dependencies.getState() };
      case "refresh":
        if (!hasExactKeys(message, ["type"])) throw new UiRequestError("INVALID_UI_REQUEST");
        return { ok: true, state: await dependencies.refresh() };
      case "reconnect_development_browser":
        if (!hasExactKeys(message, ["type"])) throw new UiRequestError("INVALID_UI_REQUEST");
        if (!dependencies.reconnectDevelopmentBrowser) throw new UiRequestError("UNSUPPORTED_UI_REQUEST");
        return { ok: true, state: await dependencies.reconnectDevelopmentBrowser() };
      case "pair_browser": {
        if (!hasExactKeys(message, ["type", "params"]) || !isRecord(message.params)) {
          throw new UiRequestError("INVALID_UI_REQUEST");
        }
        const params = message.params;
        if (
          !hasExactKeys(params, ["contract_version", "server_base_url", "pairing_code"])
          || params.contract_version !== 1
        ) {
          throw new UiRequestError("INVALID_UI_REQUEST");
        }
        const submission = parsePairingSubmission(params.server_base_url, params.pairing_code);
        return { ok: true, state: await dependencies.pair(submission) };
      }
      case "disconnect_browser":
        if (!hasExactKeys(message, ["type", "confirmed"]) || message.confirmed !== true) {
          throw new UiRequestError("INVALID_UI_REQUEST");
        }
        return { ok: true, state: await dependencies.disconnect() };
      case "context_list":
        if (!hasExactKeys(message, ["type"]) || !routeContext) {
          throw new UiRequestError("INVALID_UI_REQUEST");
        }
        return { ok: true, context: await dependencies.contextList(routeContext.panelId) };
      case "context_subscribe": {
        if (!hasExactKeys(message, ["type", "params"]) || !isRecord(message.params) || !routeContext) {
          throw new UiRequestError("INVALID_UI_REQUEST");
        }
        const params = message.params;
        if (!hasExactKeys(params, ["context_id"], ["from", "history", "history_before"])) {
          throw new UiRequestError("INVALID_UI_REQUEST");
        }
        if (
          typeof params.context_id !== "string"
          || (params.from !== undefined && typeof params.from !== "number")
          || (params.history !== undefined && params.history !== "tail")
          || (params.history_before !== undefined && typeof params.history_before !== "number")
        ) {
          throw new UiRequestError("INVALID_UI_REQUEST");
        }
        const input: ContextSubscribeInput = {
          contextId: params.context_id,
          ...(params.from === undefined ? {} : { from: params.from }),
          ...(params.history === undefined ? {} : { history: params.history }),
          ...(params.history_before === undefined ? {} : { historyBefore: params.history_before }),
        };
        try {
          buildContextSubscribeParams(input);
        } catch {
          throw new UiRequestError("INVALID_UI_REQUEST");
        }
        return { ok: true, context: await dependencies.contextSubscribe(routeContext.panelId, input) };
      }
      case "context_unsubscribe": {
        if (!hasExactKeys(message, ["type", "params"]) || !isRecord(message.params) || !routeContext) {
          throw new UiRequestError("INVALID_UI_REQUEST");
        }
        const params = message.params;
        if (!hasExactKeys(params, ["context_id"])) throw new UiRequestError("INVALID_UI_REQUEST");
        if (typeof params.context_id !== "string") throw new UiRequestError("INVALID_UI_REQUEST");
        const contextId = params.context_id;
        try {
          buildContextUnsubscribeParams(contextId);
        } catch {
          throw new UiRequestError("INVALID_UI_REQUEST");
        }
        return { ok: true, context: await dependencies.contextUnsubscribe(routeContext.panelId, contextId) };
      }
      case "context_send_message": {
        if (!hasExactKeys(message, ["type", "params"]) || !isRecord(message.params) || !routeContext) {
          throw new UiRequestError("INVALID_UI_REQUEST");
        }
        const params = message.params;
        if (!hasExactKeys(params, ["context_id", "client_message_id", "text"])) {
          throw new UiRequestError("INVALID_UI_REQUEST");
        }
        if (
          typeof params.context_id !== "string"
          || typeof params.client_message_id !== "string"
          || typeof params.text !== "string"
        ) {
          throw new UiRequestError("INVALID_UI_REQUEST");
        }
        const input = {
          contextId: params.context_id,
          clientMessageId: params.client_message_id,
          text: params.text,
        };
        try {
          buildContextSendMessageParams(input);
        } catch {
          throw new UiRequestError("INVALID_UI_REQUEST");
        }
        return { ok: true, result: await dependencies.contextSendMessage(routeContext.panelId, input) };
      }
      default:
        throw new UiRequestError("UNSUPPORTED_UI_REQUEST");
    }
  };
}
