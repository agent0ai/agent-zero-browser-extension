import { createOwnedFavicon, OWNED_FAVICON_URL } from "./favicon";

it("preserves original site icons and removes only the owned unchanged favicon", () => {
  const original = { href: "/site.ico" };
  const children: unknown[] = [original];
  const attributes = new Map<string, string>();
  const link = {
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    getAttribute: (name: string) => attributes.get(name),
    remove: () => children.splice(children.indexOf(link), 1),
  };
  const document = { head: { append: (node: unknown) => children.push(node) }, createElement: () => link } as unknown as Document;
  const indicator = createOwnedFavicon(document)!;
  expect(children).toEqual([original, link]);
  expect(original).toEqual({ href: "/site.ico" });
  expect(attributes.get("href")).toBe(OWNED_FAVICON_URL);
  const svg = decodeURIComponent(OWNED_FAVICON_URL.split(",")[1]);
  expect(svg).toContain('opacity="0.65"');
  expect(svg.match(/<path /g)).toHaveLength(2);
  indicator.remove();
  indicator.remove();
  expect(children).toEqual([original]);

  const changed = createOwnedFavicon(document)!;
  attributes.set("href", "/new-site-icon.ico");
  changed.remove();
  expect(children).toEqual([original, link]);
  expect(createOwnedFavicon({ head: null } as unknown as Document)).toBeNull();
});
