import type { ComponentChildren } from "preact";
import "./Markdown.css";

// A deliberately small, presentation-only Markdown subset. Everything becomes
// text nodes or fixed elements; HTML, images, embeds and automatic URL fetches
// are never interpreted. Budget exhaustion preserves the remaining text.
const MAX_FORMATTED_CHARS = 65_536;
const MAX_BLOCK_LINES = 2_048;
const MAX_NODES = 2_048;
type Budget = { remaining: number; scanWork: number };

function safeLink(value: string): string | null {
  if (!/^https?:\/\//iu.test(value) || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
      ? url.href : null;
  } catch { return null; }
}

function inline(text: string, budget: Budget, depth = 0, links = true): ComponentChildren[] {
  if (depth >= 6 || budget.remaining <= 0) return [text];
  const result: ComponentChildren[] = [];
  let offset = 0;
  let plain = "";
  const flush = () => { if (plain) { result.push(plain); plain = ""; } };
  while (offset < text.length && budget.remaining > 0) {
    const rest = text.slice(offset);
    // Bound repeated delimiter searches on hostile/unclosed markup as well as
    // the number of rendered elements. Preserve text when parsing runs out.
    if (/[!`*_[\\]/u.test(rest[0])) {
      budget.scanWork -= rest.length;
      if (budget.scanWork < 0) break;
    }
    // Preserve image syntax as literal text, including its destination.
    const image = /^!\[(?:\\[\[\]\\]|[^\]\\\n])*\]\([^\n]*?\)/u.exec(rest);
    if (image) { plain += image[0]; offset += image[0].length; continue; }
    if (rest[0] === "\\" && /^[\\`*_[\]!]/u.test(rest[1] ?? "")) {
      plain += rest[1]; offset += 2; continue;
    }
    const code = /^`([^`\n]+)`/u.exec(rest);
    if (code) {
      flush(); budget.remaining--; result.push(<code>{code[1]}</code>); offset += code[0].length; continue;
    }
    const link = links ? /^\[((?:\\[\[\]\\]|[^\]\\\n])+)\]\(([^\s()]*)\)/u.exec(rest) : null;
    if (link) {
      const href = safeLink(link[2]);
      if (href) {
        flush(); budget.remaining--;
        result.push(<a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
          {inline(link[1], budget, depth + 1, false)}
        </a>);
      } else { plain += link[0]; }
      offset += link[0].length; continue;
    }
    const marker = rest.startsWith("**") || rest.startsWith("__") ? rest.slice(0, 2)
      : rest[0] === "*" || rest[0] === "_" ? rest[0] : null;
    // Underscores inside identifiers are not formatting delimiters.
    if (marker && !(marker[0] === "_" && /[\p{L}\p{N}]/u.test(text[offset - 1] ?? ""))) {
      const end = rest.indexOf(marker, marker.length);
      const body = end > marker.length ? rest.slice(marker.length, end) : "";
      if (body && !/^\s|\s$/u.test(body)) {
        flush(); budget.remaining--;
        const children = inline(body, budget, depth + 1, links);
        result.push(marker.length === 2 ? <strong>{children}</strong> : <em>{children}</em>);
        offset += end + marker.length; continue;
      }
    }
    plain += text[offset++];
  }
  plain += text.slice(offset);
  flush();
  return result;
}

const listItem = (line: string) => /^ {0,3}([-+*]|\d{1,6}[.)])\s+(.+)$/u.exec(line);
const fence = (line: string) => /^ {0,3}(`{3,}|~{3,})([^`~]*)$/u.exec(line);
const quote = (line: string) => /^ {0,3}>\s?(.*)$/u.exec(line);
const heading = (line: string) => /^ {0,3}(#{1,6})\s+(.+)$/u.exec(line);
const startsBlock = (line: string) => !line.trim() || fence(line) || listItem(line) || quote(line) || heading(line);

function blocks(text: string): ComponentChildren[] {
  const budget: Budget = { remaining: MAX_NODES, scanWork: 2_097_152 };
  const formatted = text.slice(0, MAX_FORMATTED_CHARS).replace(/\r\n?/gu, "\n");
  const lines = formatted.split("\n");
  const result: ComponentChildren[] = [];
  let index = 0;
  while (index < lines.length && index < MAX_BLOCK_LINES && budget.remaining > 0) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    budget.remaining--;
    const opened = fence(line);
    if (opened) {
      const content: string[] = [];
      index++;
      while (index < lines.length && index < MAX_BLOCK_LINES) {
        const closed = fence(lines[index]);
        if (closed && closed[1][0] === opened[1][0] && closed[1].length >= opened[1].length && !closed[2].trim()) {
          index++; break;
        }
        content.push(lines[index++]);
      }
      result.push(<pre tabIndex={0} aria-label="Code block"><code>{content.join("\n")}</code></pre>);
      continue;
    }
    const title = heading(line);
    if (title) {
      // Message headings are subordinate to the panel's own document structure.
      result.push(<p class="a0-markdown-heading">{inline(title[2], budget)}</p>);
      index++; continue;
    }
    const item = listItem(line);
    if (item) {
      const ordered = /^\d/u.test(item[1]);
      const items: ComponentChildren[] = [];
      while (index < lines.length && index < MAX_BLOCK_LINES && budget.remaining > 0) {
        const next = listItem(lines[index]);
        if (!next || /^\d/u.test(next[1]) !== ordered) break;
        budget.remaining--;
        items.push(<li>{inline(next[2], budget)}</li>); index++;
      }
      result.push(ordered ? <ol start={Number.parseInt(item[1], 10)}>{items}</ol> : <ul>{items}</ul>);
      continue;
    }
    if (quote(line)) {
      const content: string[] = [];
      while (index < lines.length && index < MAX_BLOCK_LINES) {
        const next = quote(lines[index]);
        if (!next) break;
        content.push(next[1]); index++;
      }
      result.push(<blockquote><p>{inline(content.join("\n"), budget)}</p></blockquote>);
      continue;
    }
    const content = [line]; index++;
    while (index < lines.length && index < MAX_BLOCK_LINES && !startsBlock(lines[index])) content.push(lines[index++]);
    result.push(<p>{inline(content.join("\n"), budget)}</p>);
  }
  const remainder = lines.slice(index).join("\n") + text.slice(MAX_FORMATTED_CHARS);
  if (remainder) result.push(<p>{remainder}</p>);
  return result;
}

export function Markdown({ text }: { text: string }) {
  return <div class="a0-markdown">{blocks(text)}</div>;
}
