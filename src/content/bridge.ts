import { CursorController, CursorMoveInterruptedError } from "./cursor";
import { createCursorOverlay } from "./overlay";
import { createOwnedFavicon } from "./favicon";
import {
  CONTENT_CONTRACT,
  bindingFromCommand,
  bindingsEqual,
  isTrustedWorkerSender,
  parseContentEnvelope,
  type ContentBinding,
  type ContentBindResponse,
  type ContentCommandEnvelope,
  type ContentErrorCode,
  type ContentRejectedResponse,
  type ContentResponse,
  type CursorArrivedEvent,
} from "./protocol";
import {
  ElementReferenceRegistry,
  inspectSemanticDocument,
  semanticName,
  semanticRole,
  visiblePointForRect,
} from "./semantics";

type RuntimeReply = ContentBindResponse | ContentRejectedResponse | ContentResponse;

type ClickActionClass = "reversible_input" | "sensitive_input" | "external_side_effect" | "unknown";
type ClickTargetResolution =
  | {
      ok: true;
      element: Element;
      point: { x: number; y: number };
      actionClass: ClickActionClass;
      targetFingerprint: string;
    }
  | {
      ok: false;
      code: "STALE_ELEMENT_REFERENCE" | "TARGET_NOT_VISIBLE" | "TARGET_UNSUPPORTED";
      message: string;
    };

type TypeTargetElement = HTMLInputElement | HTMLTextAreaElement;
type TypeTargetResolution =
  | {
      ok: true;
      element: TypeTargetElement;
      point: { x: number; y: number };
      targetFingerprint: string;
    }
  | {
      ok: false;
      code: "STALE_ELEMENT_REFERENCE" | "TARGET_NOT_VISIBLE" | "TARGET_UNSUPPORTED" | "TARGET_CHANGED";
      message: string;
    };

const consequentialName = /\b(?:buy|checkout|confirm|delete|download|install|log\s*out|pay|publish|purchase|remove|save|send|sign\s*out|submit|subscribe|transfer|unsubscribe|upload)\b/iu;
const sensitiveName = /\b(?:credential|financial|health|identity|password|secret|security|ssn)\b/iu;

const boundedAttribute = (element: Element, name: string, maximum = 128): string =>
  (element.getAttribute(name) || "").trim().toLowerCase().slice(0, maximum) || "none";

const classifiedAttribute = (element: Element, name: string, allowed: readonly string[]): string => {
  const value = boundedAttribute(element, name);
  return value === "none" || allowed.includes(value) ? value : "other";
};

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const digest = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export type ContentRuntimeDependencies = {
  extensionId: string;
  extensionOrigin: string;
  ownerDocument: Document;
  cursor: CursorController;
  now?: () => number;
  viewport?: () => { width: number; height: number };
  emitArrival?: (event: CursorArrivedEvent) => void | Promise<void>;
  createFavicon?: () => { remove(): void } | null;
};

const rejected = (code: ContentErrorCode, message: string): ContentRejectedResponse => ({
  contract: CONTENT_CONTRACT,
  kind: "content.rejected",
  ok: false,
  error: { code, message, outcome: "not_applied" },
});

const commandError = (
  envelope: ContentCommandEnvelope,
  code: ContentErrorCode,
  message: string,
): ContentResponse => ({
  contract: CONTENT_CONTRACT,
  kind: "content.response",
  ...bindingFromCommand(envelope),
  command_id: envelope.command_id,
  operation_id: envelope.operation_id,
  action_id: envelope.action_id,
  ok: false,
  error: { code, message, outcome: "not_applied" },
});

const commandResult = (
  envelope: ContentCommandEnvelope,
  result: NonNullable<ContentResponse["result"]>,
): ContentResponse => ({
  contract: CONTENT_CONTRACT,
  kind: "content.response",
  ...bindingFromCommand(envelope),
  command_id: envelope.command_id,
  operation_id: envelope.operation_id,
  action_id: envelope.action_id,
  ok: true,
  result,
});

export const isContentProtocolMessage = (value: unknown): boolean =>
  typeof value === "object" && value !== null && (value as { contract?: unknown }).contract === CONTENT_CONTRACT;

export class ContentRuntime {
  private binding: ContentBinding | null = null;
  private references: ElementReferenceRegistry | null = null;
  private released = false;
  private favicon: { remove(): void } | null = null;
  private readonly arrivedActions = new Set<string>();
  private readonly activatedActions = new Set<string>();
  private readonly now: () => number;
  private readonly viewport: () => { width: number; height: number };
  private readonly emitArrival: (event: CursorArrivedEvent) => void | Promise<void>;

  constructor(private readonly dependencies: ContentRuntimeDependencies) {
    this.now = dependencies.now ?? (() => Date.now());
    this.viewport = dependencies.viewport ?? (() => ({ width: window.innerWidth, height: window.innerHeight }));
    this.emitArrival = dependencies.emitArrival ?? (() => undefined);
  }

  registerElement(element: Element): string {
    if (!this.references || this.released) throw new Error("The content runtime is not bound to an active document.");
    return this.references.register(element);
  }

  async handle(message: unknown, sender: chrome.runtime.MessageSender): Promise<RuntimeReply> {
    if (
      !isTrustedWorkerSender(
        sender,
        this.dependencies.extensionId,
        this.dependencies.extensionOrigin,
      )
    ) {
      return rejected("UNTRUSTED_SENDER", "Only this extension's service worker may control the content runtime.");
    }

    const parsed = parseContentEnvelope(message, this.now());
    if (!parsed.ok) {
      if (parsed.envelope?.kind === "content.command") {
        return commandError(parsed.envelope, parsed.code, "The content command deadline elapsed.");
      }
      return rejected(
        parsed.code,
        parsed.code === "DEADLINE_EXCEEDED" ? "The content command deadline elapsed." : "The content envelope is invalid.",
      );
    }

    if (parsed.envelope.kind === "content.bind") {
      if (this.released) return rejected("RELEASED", "This content runtime was released.");
      if (this.binding && !bindingsEqual(this.binding, parsed.envelope.binding)) {
        return rejected("STALE_BINDING", "This content runtime is already bound to another document lease.");
      }
      if (!this.binding) {
        this.binding = { ...parsed.envelope.binding };
        this.references = new ElementReferenceRegistry(
          parsed.envelope.binding.document_epoch,
          this.dependencies.ownerDocument,
        );
      }
      if (parsed.envelope.agent_created_favicon === true && !this.favicon) {
        try {
          this.favicon = this.dependencies.createFavicon
            ? this.dependencies.createFavicon()
            : createOwnedFavicon(this.dependencies.ownerDocument);
        } catch {
          // Cosmetic favicon support must never change browser-operation success.
        }
      } else if (parsed.envelope.agent_created_favicon !== true) {
        this.removeFavicon();
      }
      return {
        contract: CONTENT_CONTRACT,
        kind: "content.bound",
        ok: true,
        binding: { ...this.binding },
      };
    }

    const envelope = parsed.envelope;
    if (this.released) return commandError(envelope, "RELEASED", "This content runtime was released.");
    if (!this.binding) return commandError(envelope, "UNBOUND", "Bind the document lease before sending commands.");
    if (!bindingsEqual(this.binding, bindingFromCommand(envelope))) {
      return commandError(envelope, "STALE_BINDING", "The command does not match the bound document lease.");
    }

    try {
      return await this.execute(envelope);
    } catch (error) {
      if (error instanceof CursorMoveInterruptedError) {
        return commandError(envelope, "CURSOR_INTERRUPTED", "Cursor travel was interrupted before arrival.");
      }
      return commandError(envelope, "CONTENT_RUNTIME_ERROR", "The isolated content runtime could not apply the command.");
    }
  }

  handleNavigation(): void {
    this.release();
  }

  private async execute(envelope: ContentCommandEnvelope): Promise<ContentResponse> {
    const { command } = envelope;
    switch (command.name) {
      case "semantics.inspect": {
        if (!this.references) {
          return commandError(envelope, "UNBOUND", "Bind the document lease before inspecting page semantics.");
        }
        const snapshot = await inspectSemanticDocument(this.dependencies.ownerDocument, this.references, {
          ...(command.max_nodes === undefined ? {} : { maxNodes: command.max_nodes }),
          ...(command.max_text_chars === undefined ? {} : { maxTextChars: command.max_text_chars }),
        });
        return commandResult(envelope, { state: "inspected", snapshot });
      }
      case "page.scroll_to_ref": {
        const resolved = this.references?.resolve(command.element_ref);
        if (!resolved?.ok) {
          return commandError(envelope, "STALE_ELEMENT_REFERENCE", "The element reference is stale for this document.");
        }
        resolved.element.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
        const target = visiblePointForRect(resolved.element.getBoundingClientRect(), this.viewport());
        if (!target.ok) {
          return commandError(envelope, target.code, "The referenced element did not become visible after scrolling.");
        }
        if (command.show_cursor) {
          const point = await this.dependencies.cursor.moveTo(target.point, true);
          this.emitArrivalOnce(envelope, point);
          return commandResult(envelope, { state: "scrolled", ...point });
        }
        return commandResult(envelope, { state: "scrolled", ...target.point });
      }
      case "target.prepare_hover": {
        const first = this.resolveHoverTarget(command.element_ref);
        if (!first.ok) return commandError(envelope, first.code, first.message);
        const point = await this.dependencies.cursor.moveTo(first.point, true);
        const current = this.resolveHoverTarget(command.element_ref);
        if (
          !current.ok
          || current.element !== first.element
          || Math.abs(current.point.x - point.x) > 0.5
          || Math.abs(current.point.y - point.y) > 0.5
        ) {
          this.dependencies.cursor.teardown();
          return commandError(envelope, "TARGET_NOT_VISIBLE", "The hover target moved before dispatch.");
        }
        this.emitArrivalOnce(envelope, point);
        return commandResult(envelope, { state: "hover_ready", ...point });
      }
      case "target.prepare_click":
      case "target.prepare_upload": {
        const resolve = command.name === "target.prepare_upload"
          ? (ref: string) => this.resolveUploadTarget(ref) : (ref: string) => this.resolveClickTarget(ref);
        const first = await resolve(command.element_ref);
        if (!first.ok) return commandError(envelope, first.code, first.message);
        const point = await this.dependencies.cursor.moveTo(first.point, true);
        const current = await resolve(command.element_ref);
        if (
          !current.ok
          || current.element !== first.element
          || current.targetFingerprint !== first.targetFingerprint
          || Math.abs(current.point.x - point.x) > 0.5
          || Math.abs(current.point.y - point.y) > 0.5
        ) {
          this.dependencies.cursor.teardown();
          return commandError(envelope, "TARGET_CHANGED", "The click target changed during cursor travel.");
        }
        this.emitArrivalOnce(envelope, point);
        return commandResult(envelope, {
          state: "click_ready",
          ...point,
          action_class: current.actionClass,
          target_fingerprint: current.targetFingerprint,
        });
      }
      case "target.revalidate_click":
      case "target.revalidate_upload": {
        const current = command.name === "target.revalidate_upload"
          ? await this.resolveUploadTarget(command.element_ref) : await this.resolveClickTarget(command.element_ref);
        if (!current.ok) return commandError(envelope, current.code, current.message);
        if (current.targetFingerprint !== command.target_fingerprint) {
          return commandError(envelope, "TARGET_CHANGED", "The click target no longer matches its approved fingerprint.");
        }
        return commandResult(envelope, {
          state: "click_ready",
          ...current.point,
          action_class: current.actionClass,
          target_fingerprint: current.targetFingerprint,
        });
      }
      case "target.prepare_type": {
        const first = await this.resolveTypeTarget(command.element_ref, command.has_line_feed, "empty");
        if (!first.ok) return commandError(envelope, first.code, first.message);
        const point = await this.dependencies.cursor.moveTo(first.point, true);
        const current = await this.resolveTypeTarget(command.element_ref, command.has_line_feed, "empty");
        if (
          !current.ok
          || current.element !== first.element
          || current.targetFingerprint !== first.targetFingerprint
          || current.point.x !== point.x
          || current.point.y !== point.y
        ) {
          this.dependencies.cursor.teardown();
          return commandError(envelope, "TARGET_CHANGED", "The type target changed during cursor travel.");
        }
        this.emitArrivalOnce(envelope, point);
        return commandResult(envelope, {
          state: "type_ready",
          ...point,
          action_class: "sensitive_input",
          target_fingerprint: current.targetFingerprint,
        });
      }
      case "target.revalidate_type": {
        const current = await this.resolveTypeTarget(command.element_ref, command.has_line_feed, "empty");
        if (!current.ok) return commandError(envelope, current.code, current.message);
        if (current.targetFingerprint !== command.target_fingerprint) {
          return commandError(envelope, "TARGET_CHANGED", "The type target no longer matches its approved fingerprint.");
        }
        return commandResult(envelope, {
          state: "type_ready",
          ...current.point,
          action_class: "sensitive_input",
          target_fingerprint: current.targetFingerprint,
        });
      }
      case "target.confirm_type_focus": {
        const current = await this.resolveTypeTarget(command.element_ref, command.has_line_feed, "empty");
        if (!current.ok) return commandError(envelope, current.code, current.message);
        if (
          current.targetFingerprint !== command.target_fingerprint
          || this.dependencies.ownerDocument.activeElement !== current.element
        ) {
          return commandError(envelope, "TARGET_CHANGED", "Chrome did not focus the exact approved empty type target.");
        }
        return commandResult(envelope, { state: "type_focus_ready" });
      }
      case "target.verify_type_value": {
        const current = await this.resolveTypeTarget(
          command.element_ref,
          command.has_line_feed,
          { textSha256: command.text_sha256 },
        );
        if (!current.ok) return commandError(envelope, current.code, current.message);
        if (
          current.targetFingerprint !== command.target_fingerprint
          || this.dependencies.ownerDocument.activeElement !== current.element
        ) {
          return commandError(envelope, "TARGET_CHANGED", "The exact approved type target changed after input.");
        }
        return commandResult(envelope, { state: "type_verified" });
      }
      case "cursor.move_to_point": {
        const point = await this.dependencies.cursor.moveTo({ x: command.x, y: command.y }, command.show_label);
        this.emitArrivalOnce(envelope, point);
        return commandResult(envelope, { state: "arrived", ...point });
      }
      case "cursor.move_to_ref": {
        const resolved = this.references?.resolve(command.element_ref);
        if (!resolved?.ok) {
          return commandError(envelope, "STALE_ELEMENT_REFERENCE", "The element reference is stale for this document.");
        }
        const style = this.dependencies.ownerDocument.defaultView?.getComputedStyle(resolved.element);
        if (
          style?.display === "none" ||
          style?.visibility === "hidden" ||
          style?.visibility === "collapse" ||
          style?.contentVisibility === "hidden" ||
          style?.pointerEvents === "none" ||
          Number.parseFloat(style?.opacity ?? "1") === 0
        ) {
          return commandError(envelope, "TARGET_NOT_VISIBLE", "The referenced element is not visibly actionable.");
        }
        const target = visiblePointForRect(resolved.element.getBoundingClientRect(), this.viewport());
        if (!target.ok) {
          return commandError(envelope, target.code, "The referenced element has no safe visible endpoint.");
        }
        const point = await this.dependencies.cursor.moveTo(target.point, command.show_label);
        this.emitArrivalOnce(envelope, point);
        return commandResult(envelope, { state: "arrived", ...point });
      }
      case "cursor.activate": {
        const point = this.dependencies.cursor.currentPoint;
        if (!point) return commandError(envelope, "TARGET_NOT_VISIBLE", "The cursor has no current action endpoint.");
        if (!this.activatedActions.has(envelope.action_id) && this.activatedActions.size < 1_024) {
          this.activatedActions.add(envelope.action_id);
          this.dependencies.cursor.activate();
        }
        return commandResult(envelope, { state: "activated", ...point });
      }
      case "cursor.freeze": {
        const point = this.dependencies.cursor.freeze();
        return commandResult(envelope, { state: "frozen", ...(point ?? {}) });
      }
      case "cursor.cancel":
        this.dependencies.cursor.teardown();
        this.removeFavicon();
        return commandResult(envelope, { state: "cancelled" });
      case "runtime.release":
        this.release();
        return commandResult(envelope, { state: "released" });
    }
  }

  private resolveHoverTarget(reference: string):
    | { ok: true; element: Element; point: { x: number; y: number } }
    | { ok: false; code: "STALE_ELEMENT_REFERENCE" | "TARGET_NOT_VISIBLE"; message: string } {
    const resolved = this.references?.resolve(reference);
    if (!resolved?.ok) {
      return {
        ok: false,
        code: "STALE_ELEMENT_REFERENCE",
        message: "The element reference is stale for this document.",
      };
    }
    const style = this.dependencies.ownerDocument.defaultView?.getComputedStyle(resolved.element);
    if (
      style?.display === "none"
      || style?.visibility === "hidden"
      || style?.visibility === "collapse"
      || style?.contentVisibility === "hidden"
      || style?.pointerEvents === "none"
      || Number.parseFloat(style?.opacity ?? "1") === 0
    ) {
      return { ok: false, code: "TARGET_NOT_VISIBLE", message: "The referenced element is not visibly hoverable." };
    }
    const target = visiblePointForRect(resolved.element.getBoundingClientRect(), this.viewport());
    if (!target.ok) {
      return { ok: false, code: target.code, message: "The referenced element has no safe visible hover point." };
    }
    const hit = this.dependencies.ownerDocument.elementFromPoint(target.point.x, target.point.y);
    if (!hit || (hit !== resolved.element && !resolved.element.contains(hit))) {
      return { ok: false, code: "TARGET_NOT_VISIBLE", message: "The referenced element is occluded at its hover point." };
    }
    return { ok: true, element: resolved.element, point: target.point };
  }

  private async resolveClickTarget(reference: string): Promise<ClickTargetResolution> {
    const resolved = this.references?.resolve(reference);
    if (!resolved?.ok) {
      return {
        ok: false,
        code: "STALE_ELEMENT_REFERENCE",
        message: "The element reference is stale for this document.",
      };
    }
    const element = resolved.element;
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute("type") || "").toLowerCase();
    const role = semanticRole(element).toLowerCase();
    const form = element.closest("form");
    const formMethod = form === null
      ? "none"
      : classifiedAttribute(form, "method", ["get", "post", "dialog"]);
    const isSubmitter = (tag === "button" && (type === "" || type === "submit"))
      || (tag === "input" && (type === "submit" || type === "image"));
    if (
      tag === "a"
      || tag === "area"
      || tag === "label"
      || type === "file"
      || type === "reset"
      || element.hasAttribute("formaction")
      || (isSubmitter && form !== null)
    ) {
      return {
        ok: false,
        code: "TARGET_UNSUPPORTED",
        message: "Navigation, form submission, reset, label, and file-picker targets are not supported by semantic click.",
      };
    }
    const disabled = element.getAttribute("aria-disabled") === "true"
      || ("disabled" in element && Boolean((element as Element & { disabled?: boolean }).disabled));
    const style = this.dependencies.ownerDocument.defaultView?.getComputedStyle(element);
    if (
      disabled
      || element.hasAttribute("hidden")
      || element.getAttribute("aria-hidden") === "true"
      || style?.display === "none"
      || style?.visibility === "hidden"
      || style?.visibility === "collapse"
      || style?.contentVisibility === "hidden"
      || style?.pointerEvents === "none"
      || Number.parseFloat(style?.opacity ?? "1") === 0
    ) {
      return { ok: false, code: "TARGET_NOT_VISIBLE", message: "The referenced element is not enabled and visibly clickable." };
    }
    const rect = element.getBoundingClientRect();
    const viewport = this.viewport();
    const target = visiblePointForRect(rect, viewport);
    if (!target.ok) {
      return { ok: false, code: target.code, message: "The referenced element has no safe visible click point." };
    }
    const hit = this.dependencies.ownerDocument.elementFromPoint(target.point.x, target.point.y);
    if (!hit || (hit !== element && !element.contains(hit))) {
      return { ok: false, code: "TARGET_NOT_VISIBLE", message: "The referenced element is occluded at its click point." };
    }
    const name = semanticName(element);
    let actionClass: ClickActionClass;
    if (sensitiveName.test(name) || type === "password") {
      actionClass = "sensitive_input";
    } else if (consequentialName.test(name)) {
      actionClass = "external_side_effect";
    } else if (
      tag === "summary"
      || (tag === "button" && (type === "button" || form === null))
      || (tag === "input" && ["button", "checkbox", "radio"].includes(type))
    ) {
      actionClass = "reversible_input";
    } else {
      actionClass = "unknown";
    }
    const targetFingerprint = await digest(stableJson({
      action: "click",
      action_class: actionClass,
      data_classification: "none",
      document_epoch: this.binding?.document_epoch,
      element_ref: reference,
      form_method: formMethod,
      geometry: {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
        x: target.point.x,
        y: target.point.y,
      },
      name_digest: await digest(name),
      role,
      semantic_state: {
        aria_checked: element.getAttribute("aria-checked") || "none",
        aria_expanded: element.getAttribute("aria-expanded") || "none",
        aria_pressed: element.getAttribute("aria-pressed") || "none",
        aria_selected: element.getAttribute("aria-selected") || "none",
        checked: "checked" in element ? Boolean((element as Element & { checked?: boolean }).checked) : false,
        indeterminate: "indeterminate" in element
          ? Boolean((element as Element & { indeterminate?: boolean }).indeterminate)
          : false,
        open: element.hasAttribute("open"),
      },
      tag,
      type: type || "none",
      viewport,
    }));
    return { ok: true, element, point: target.point, actionClass, targetFingerprint };
  }

  private async resolveUploadTarget(reference: string): Promise<ClickTargetResolution> {
    const resolved = this.references?.resolve(reference);
    if (!resolved?.ok) return { ok: false, code: "STALE_ELEMENT_REFERENCE", message: "The file field reference is stale." };
    const element = resolved.element as HTMLInputElement;
    if (element.tagName.toLowerCase() !== "input" || element.type !== "file"
      || element.multiple || element.hasAttribute("webkitdirectory") || element.hasAttribute("directory")
      || element.disabled || element.files?.length !== 0 || element.getAttribute("aria-disabled") === "true") {
      return { ok: false, code: "TARGET_UNSUPPORTED", message: "Choose an empty, enabled single-file field." };
    }
    const style = this.dependencies.ownerDocument.defaultView?.getComputedStyle(element);
    if (element.hidden || element.getAttribute("aria-hidden") === "true" || style?.display === "none"
      || style?.visibility === "hidden" || style?.visibility === "collapse" || style?.contentVisibility === "hidden"
      || style?.pointerEvents === "none" || Number.parseFloat(style?.opacity ?? "1") === 0) {
      return { ok: false, code: "TARGET_NOT_VISIBLE", message: "The file field must be visible." };
    }
    const rect = element.getBoundingClientRect();
    const viewport = this.viewport();
    const visible = visiblePointForRect(rect, viewport);
    if (!visible.ok) return { ok: false, code: "TARGET_NOT_VISIBLE", message: "The file field has no visible point." };
    const point = { x: Math.round(visible.point.x), y: Math.round(visible.point.y) };
    if (point.x < Math.max(0, rect.left) || point.x >= Math.min(viewport.width, rect.right)
      || point.y < Math.max(0, rect.top) || point.y >= Math.min(viewport.height, rect.bottom)
      || this.dependencies.ownerDocument.elementFromPoint(point.x, point.y) !== element) {
      return { ok: false, code: "TARGET_NOT_VISIBLE", message: "The file field is occluded." };
    }
    const targetFingerprint = await digest(stableJson({ action: "upload_file", action_class: "external_side_effect",
      data_classification: "none", document_epoch: this.binding?.document_epoch, element_ref: reference,
      geometry: { x: point.x, y: point.y, left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      accept_digest: await digest(element.accept), name_digest: await digest(semanticName(element)),
      form_action_digest: await digest(element.form?.action || "none"),
      form_method: element.form?.method || "none", viewport, precondition: "empty_single_file" }));
    return { ok: true, element, point, actionClass: "external_side_effect", targetFingerprint };
  }

  private async resolveTypeTarget(
    reference: string,
    hasLineFeed: boolean,
    valueExpectation: "empty" | { textSha256: string },
  ): Promise<TypeTargetResolution> {
    const resolved = this.references?.resolve(reference);
    if (!resolved?.ok) {
      return {
        ok: false,
        code: "STALE_ELEMENT_REFERENCE",
        message: "The element reference is stale for this document.",
      };
    }
    const element = resolved.element;
    const tag = element.tagName.toLowerCase();
    const type = tag === "input" ? (element.getAttribute("type") || "text").toLowerCase() : "textarea";
    if (
      (tag !== "input" && tag !== "textarea")
      || (tag === "input" && !["text", "search", "email", "tel", "url", "password"].includes(type))
      || (tag === "input" && hasLineFeed)
    ) {
      return {
        ok: false,
        code: "TARGET_UNSUPPORTED",
        message: "Semantic type supports only bounded text inputs and textareas without submit behavior.",
      };
    }
    const field = element as TypeTargetElement;
    const disabled = field.disabled || element.getAttribute("aria-disabled") === "true";
    const readOnly = field.readOnly || element.getAttribute("aria-readonly") === "true";
    const style = this.dependencies.ownerDocument.defaultView?.getComputedStyle(element);
    if (
      disabled
      || readOnly
      || element.hasAttribute("hidden")
      || element.getAttribute("aria-hidden") === "true"
      || style?.display === "none"
      || style?.visibility === "hidden"
      || style?.visibility === "collapse"
      || style?.contentVisibility === "hidden"
      || style?.pointerEvents === "none"
      || Number.parseFloat(style?.opacity ?? "1") === 0
    ) {
      return { ok: false, code: "TARGET_NOT_VISIBLE", message: "The referenced field is not writable and visible." };
    }
    if (valueExpectation === "empty") {
      if (field.value !== "") {
        return {
          ok: false,
          code: "TARGET_UNSUPPORTED",
          message: "The first semantic type lane supports only empty fields.",
        };
      }
    } else if (await digest(field.value) !== valueExpectation.textSha256) {
      return {
        ok: false,
        code: "TARGET_CHANGED",
        message: "The field did not retain the exact approved text digest.",
      };
    }
    const rect = element.getBoundingClientRect();
    const viewport = this.viewport();
    const visible = visiblePointForRect(rect, viewport);
    if (!visible.ok) {
      return { ok: false, code: visible.code, message: "The referenced field has no safe visible type point." };
    }
    const xs = [Math.round(visible.point.x), Math.floor(visible.point.x), Math.ceil(visible.point.x)];
    const ys = [Math.round(visible.point.y), Math.floor(visible.point.y), Math.ceil(visible.point.y)];
    let point: { x: number; y: number } | null = null;
    for (const x of [...new Set(xs)]) {
      for (const y of [...new Set(ys)]) {
        if (
          x < Math.max(0, rect.left)
          || x >= Math.min(viewport.width, rect.right)
          || y < Math.max(0, rect.top)
          || y >= Math.min(viewport.height, rect.bottom)
        ) continue;
        if (this.dependencies.ownerDocument.elementFromPoint(x, y) === element) {
          point = { x, y };
          break;
        }
      }
      if (point) break;
    }
    if (!point) {
      return { ok: false, code: "TARGET_NOT_VISIBLE", message: "The referenced field is occluded at its type point." };
    }
    const form = element.closest("form");
    const formMethod = form === null
      ? "none"
      : classifiedAttribute(form, "method", ["get", "post", "dialog"]);
    const targetFingerprint = await digest(stableJson({
      action: "type",
      action_class: "sensitive_input",
      data_classification: { kind: "text", sensitivity: "sensitive" },
      document_epoch: this.binding?.document_epoch,
      element_ref: reference,
      form_method: formMethod,
      geometry: {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
        x: point.x,
        y: point.y,
      },
      name_digest: await digest(semanticName(element)),
      precondition: { value_state: "empty" },
      role: semanticRole(element).toLowerCase(),
      semantic_state: {
        aria_invalid: classifiedAttribute(element, "aria-invalid", ["true", "false", "grammar", "spelling"]),
        aria_required: classifiedAttribute(element, "aria-required", ["true", "false"]),
        autocomplete: boundedAttribute(element, "autocomplete"),
        inputmode: classifiedAttribute(element, "inputmode", ["text", "decimal", "numeric", "tel", "search", "email", "url"]),
        maxlength: field.maxLength,
        required: field.required,
      },
      tag,
      type,
      viewport,
    }));
    return { ok: true, element: field, point, targetFingerprint };
  }

  private emitArrivalOnce(envelope: ContentCommandEnvelope, point: { x: number; y: number }): void {
    if (this.arrivedActions.has(envelope.action_id) || this.arrivedActions.size >= 1_024) return;
    this.arrivedActions.add(envelope.action_id);
    const event: CursorArrivedEvent = {
      contract: CONTENT_CONTRACT,
      kind: "cursor.arrived",
      ...bindingFromCommand(envelope),
      command_id: envelope.command_id,
      operation_id: envelope.operation_id,
      action_id: envelope.action_id,
      ...point,
    };
    try {
      void (async () => {
        try {
          await this.emitArrival(event);
        } catch {
          // Cursor telemetry is best effort and never grants page authority.
        }
      })();
    } catch {
      // Arrival is intentionally best-effort and never changes command success.
    }
  }

  private removeFavicon(): void {
    this.favicon?.remove();
    this.favicon = null;
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    this.dependencies.cursor.teardown();
    this.removeFavicon();
    this.references?.invalidate();
    this.references = null;
  }
}

export type ContentRuntimeInstallation = {
  runtime: ContentRuntime;
  dispose(): void;
};

const INSTALLATION_KEY = Symbol.for("a0.browser-bridge.content-runtime.v1");

export const installContentRuntime = (): ContentRuntimeInstallation => {
  const scope = globalThis as typeof globalThis & { [INSTALLATION_KEY]?: ContentRuntimeInstallation };
  const existing = scope[INSTALLATION_KEY];
  if (existing) return existing;

  const extensionOrigin = chrome.runtime.getURL("").replace(/\/$/, "");
  const cursor = new CursorController(() => createCursorOverlay(document));
  const runtime = new ContentRuntime({
    extensionId: chrome.runtime.id,
    extensionOrigin,
    ownerDocument: document,
    cursor,
    emitArrival: async (event) => {
      try {
        await chrome.runtime.sendMessage(event);
      } catch {
        // Arrival is best-effort telemetry; the command response remains authoritative.
      }
    },
  });

  const listener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: RuntimeReply) => void,
  ): boolean => {
    if (!isContentProtocolMessage(message)) return false;
    void (async () => {
      sendResponse(await runtime.handle(message, sender));
    })();
    return true;
  };
  const onPageHide = () => {
    runtime.handleNavigation();
    chrome.runtime.onMessage.removeListener(listener);
    delete scope[INSTALLATION_KEY];
  };

  chrome.runtime.onMessage.addListener(listener);
  window.addEventListener("pagehide", onPageHide, { once: true });

  const installation: ContentRuntimeInstallation = {
    runtime,
    dispose() {
      runtime.handleNavigation();
      chrome.runtime.onMessage.removeListener(listener);
      window.removeEventListener("pagehide", onPageHide);
      delete scope[INSTALLATION_KEY];
    },
  };
  scope[INSTALLATION_KEY] = installation;
  return installation;
};
