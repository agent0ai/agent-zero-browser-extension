import type { CursorPoint } from "./cursor";

const MAX_REFERENCES = 512;
const DEFAULT_MAX_NODES = 128;
const DEFAULT_MAX_TEXT_CHARS = 24_000;
const MAX_NODE_NAME_CHARS = 240;
const MAX_SCANNED_CANDIDATES = 1_024;
const SEMANTIC_CANDIDATE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "summary",
  "[role]",
  "[tabindex]",
  "h1",
  "h2",
  "h3",
].join(",");

export type ElementReferenceResult =
  | { ok: true; element: Element }
  | { ok: false; code: "STALE_ELEMENT_REFERENCE" };

export type VisiblePointResult =
  | { ok: true; point: CursorPoint }
  | { ok: false; code: "TARGET_NOT_VISIBLE" };

export type SemanticNode = {
  ref: string;
  role: string;
  name: string;
};

export type SemanticSnapshot = {
  title: string;
  text: string;
  nodes: SemanticNode[];
  truncated: boolean;
};

export type SemanticInspectionOptions = {
  maxNodes?: number;
  maxTextChars?: number;
  yieldControl?: () => Promise<void>;
};

const safeEpochPrefix = (documentEpoch: string): string =>
  documentEpoch.replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "document";

const randomHex = (): string => {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
};

export class ElementReferenceRegistry {
  private readonly references = new Map<string, Element>();
  private readonly referencesByElement = new WeakMap<Element, string>();
  private invalidated = false;

  constructor(
    private readonly documentEpoch: string,
    private readonly ownerDocument: Document,
    private readonly entropy: () => string = randomHex,
  ) {}

  register(element: Element): string {
    if (this.invalidated) throw new Error("The document reference registry is invalidated.");
    if (element.ownerDocument !== this.ownerDocument || !element.isConnected) {
      throw new Error("Only connected elements from the bound document can be registered.");
    }
    const existing = this.referencesByElement.get(element);
    if (existing && this.references.get(existing) === element) return existing;
    if (this.references.size >= MAX_REFERENCES) {
      throw new Error("The document reference limit was reached.");
    }

    let reference = "";
    for (let attempt = 0; attempt < 8; attempt += 1) {
      reference = `doc:${safeEpochPrefix(this.documentEpoch)}:${this.entropy()}`;
      if (!this.references.has(reference)) break;
      reference = "";
    }
    if (!reference) throw new Error("A unique document reference could not be created.");
    this.references.set(reference, element);
    this.referencesByElement.set(element, reference);
    return reference;
  }

  resolve(reference: string): ElementReferenceResult {
    if (this.invalidated) return { ok: false, code: "STALE_ELEMENT_REFERENCE" };
    const element = this.references.get(reference);
    if (!element || !element.isConnected || element.ownerDocument !== this.ownerDocument) {
      this.references.delete(reference);
      return { ok: false, code: "STALE_ELEMENT_REFERENCE" };
    }
    return { ok: true, element };
  }

  invalidate(): void {
    this.invalidated = true;
    this.references.clear();
  }
}

const boundedText = (value: string | null | undefined, maxChars: number): string =>
  (value || "").replace(/\s+/gu, " ").trim().slice(0, maxChars);

export const semanticRole = (element: Element): string => {
  const declared = boundedText(element.getAttribute("role"), 64);
  if (declared) return declared;
  const tag = element.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "summary") return "button";
  if (/^h[1-6]$/u.test(tag)) return "heading";
  if (tag === "input") {
    const type = (element.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "button" || type === "submit" || type === "reset") return "button";
    return "textbox";
  }
  return "element";
};

export const semanticName = (element: Element): string => {
  const labelled = boundedText(element.getAttribute("aria-label"), MAX_NODE_NAME_CHARS);
  if (labelled) return labelled;
  const labels = (element as Element & { labels?: NodeListOf<HTMLLabelElement> | null }).labels;
  if (labels?.length) {
    const labelText = boundedText(Array.from(labels, (label) => label.textContent || "").join(" "), MAX_NODE_NAME_CHARS);
    if (labelText) return labelText;
  }
  for (const attribute of ["alt", "title", "placeholder"] as const) {
    const text = boundedText(element.getAttribute(attribute), MAX_NODE_NAME_CHARS);
    if (text) return text;
  }
  return boundedText(element.textContent, MAX_NODE_NAME_CHARS);
};

const isSemanticallyVisible = (element: Element): boolean => {
  if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (
    style?.display === "none"
    || style?.visibility === "hidden"
    || style?.visibility === "collapse"
    || style?.contentVisibility === "hidden"
    || Number.parseFloat(style?.opacity ?? "1") === 0
  ) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 0 && rect.height > 0;
};

const defaultYieldControl = async (): Promise<void> => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const scheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (scheduler?.yield) await scheduler.yield();
};

export async function inspectSemanticDocument(
  ownerDocument: Document,
  references: ElementReferenceRegistry,
  options: SemanticInspectionOptions = {},
): Promise<SemanticSnapshot> {
  const maxNodes = Math.min(DEFAULT_MAX_NODES, Math.max(1, options.maxNodes ?? DEFAULT_MAX_NODES));
  const maxTextChars = Math.min(
    DEFAULT_MAX_TEXT_CHARS,
    Math.max(1, options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS),
  );
  const yieldControl = options.yieldControl ?? defaultYieldControl;
  const candidates = Array.from(ownerDocument.querySelectorAll(SEMANTIC_CANDIDATE_SELECTOR));
  const nodes: SemanticNode[] = [];
  const scanLimit = Math.min(candidates.length, MAX_SCANNED_CANDIDATES);

  for (let index = 0; index < scanLimit && nodes.length < maxNodes; index += 1) {
    const element = candidates[index];
    if (isSemanticallyVisible(element)) {
      nodes.push({
        ref: references.register(element),
        role: semanticRole(element),
        name: semanticName(element),
      });
    }
    if ((index + 1) % 20 === 0) await yieldControl();
  }

  const rawText = ownerDocument.body?.innerText || "";
  const text = rawText.slice(0, maxTextChars);
  return {
    title: (ownerDocument.title || "").slice(0, 512),
    text,
    nodes,
    truncated:
      rawText.length > text.length
      || candidates.length > scanLimit
      || (nodes.length >= maxNodes && candidates.length > nodes.length),
  };
}

export const visiblePointForRect = (
  rect: Pick<DOMRect, "bottom" | "height" | "left" | "right" | "top" | "width">,
  viewport: { width: number; height: number },
): VisiblePointResult => {
  const values = [rect.bottom, rect.height, rect.left, rect.right, rect.top, rect.width, viewport.width, viewport.height];
  if (
    values.some((value) => !Number.isFinite(value)) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.right <= 0 ||
    rect.bottom <= 0 ||
    rect.left >= viewport.width ||
    rect.top >= viewport.height
  ) {
    return { ok: false, code: "TARGET_NOT_VISIBLE" };
  }

  const visibleLeft = Math.max(0, rect.left);
  const visibleRight = Math.min(viewport.width, rect.right);
  const visibleTop = Math.max(0, rect.top);
  const visibleBottom = Math.min(viewport.height, rect.bottom);
  return {
    ok: true,
    point: {
      x: visibleLeft + (visibleRight - visibleLeft) / 2,
      y: visibleTop + (visibleBottom - visibleTop) / 2,
    },
  };
};
