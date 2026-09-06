import { describe, expect, it } from "vitest";
import type { ComponentChildren, VNode } from "preact";
import { Markdown } from "./Markdown";

function nodes(value: ComponentChildren): VNode<Record<string, unknown>>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("type" in value)) return [];
  const node = value as VNode<Record<string, unknown>>;
  return [node, ...nodes(node.props.children as ComponentChildren)];
}
function textContent(value: ComponentChildren): string {
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (value && typeof value === "object" && "props" in value) return textContent(value.props.children);
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

describe("safe chat Markdown", () => {
  it("formats ordinary paragraphs, emphasis, code, lists, quotes and fenced code", () => {
    const tree = Markdown({ text: "Hello **bold** and *emphasis* with `a < b`.\n\n- first\n- second\n\n3. third\n4. fourth\n\n> quoted **reply**\n\n```ts\n<script>literal</script>\n```" });
    const all = nodes(tree);
    for (const type of ["p", "strong", "em", "code", "ul", "ol", "li", "blockquote", "pre"]) {
      expect(all.some((node) => node.type === type), type).toBe(true);
    }
    expect(all.find((node) => node.type === "ol")?.props.start).toBe(3);
    expect(textContent(tree)).toContain("<script>literal</script>");
    expect(all.some((node) => node.type === "script")).toBe(false);
  });

  it("only creates explicit HTTP(S) links with opener and referrer isolation", () => {
    const all = nodes(Markdown({ text: "[**Docs**](https://example.com/docs?q=1#section) [Local](http://localhost:50080/)" }));
    const links = all.filter((node) => node.type === "a");
    expect(links).toHaveLength(2);
    expect(links[0].props).toMatchObject({ href: "https://example.com/docs?q=1#section", target: "_blank", rel: "noopener noreferrer", referrerPolicy: "no-referrer" });
    expect(nodes(links[0]).some((node) => node.type === "strong")).toBe(true);
  });

  it("renders escaped brackets and backslashes in safe tab-mention labels", () => {
    const tree = Markdown({ text: String.raw`@[A \[tab\] \\ title](https://example.com)` });
    const links = nodes(tree).filter((node) => node.type === "a");
    expect(links).toHaveLength(1);
    expect(links[0].props.href).toBe("https://example.com/");
    expect(textContent(links[0])).toBe("A [tab] \\ title");
    expect(textContent(tree)).toBe("@A [tab] \\ title");
    const unsafe = Markdown({ text: String.raw`[A \[tab\]](javascript:alert)` });
    expect(nodes(unsafe).some((node) => node.type === "a")).toBe(false);
    const image = String.raw`![A \[tab\]](https://example.com/image)`;
    const inertImage = Markdown({ text: image });
    expect(nodes(inertImage).some((node) => node.type === "img" || node.type === "a")).toBe(false);
    expect(textContent(inertImage)).toBe(image);
  });

  it.each([
    "[bad](javascript:alert)", "[bad](data:text/html,evil)", "[bad](file:///etc/passwd)",
    "[bad](chrome://settings)", "[bad](//example.com)", "[bad](https://user:pass@example.com)",
    "[bad](https://example.com\\path)", "[bad](java&#115;cript:alert)",
    "<img src=https://example.com/pixel onerror=alert(1)>", "<script>alert(1)</script>",
    "![remote](https://example.com/pixel.png)",
  ])("preserves unsafe markup as inert text: %s", (text) => {
    const tree = Markdown({ text });
    expect(textContent(tree)).toBe(text);
    for (const node of nodes(tree)) {
      expect(["a", "img", "script", "iframe", "object", "embed", "style"]).not.toContain(node.type);
      expect(node.props).not.toHaveProperty("dangerouslySetInnerHTML");
      expect(node.props).not.toHaveProperty("src");
    }
  });

  it("keeps unfinished streaming markup and unformatted overflow visible", () => {
    const streaming = "Working on **unfinished";
    expect(textContent(Markdown({ text: streaming }))).toBe(streaming);
    const long = "plain ".repeat(20_000);
    expect(textContent(Markdown({ text: long }))).toBe(long);
    const hostile = "[".repeat(65_536);
    expect(textContent(Markdown({ text: hostile }))).toBe(hostile);
    const unclosed = Markdown({ text: "```\n**not bold**" });
    expect(nodes(unclosed).filter((node) => node.type === "strong")).toHaveLength(0);
    expect(textContent(unclosed)).toBe("**not bold**");
  });
});
