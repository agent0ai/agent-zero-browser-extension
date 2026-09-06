// Exact path geometry from Core docs/res/a0-vector-graphics/lightSymbol.svg.
// This is a temporary document favicon, not a customizable Chrome system badge.
const symbolPaths = [
  "m717.77,788.27c-78.78-135.38-157.9-271.35-238.62-410.05-79.86,138.37-158.57,274.73-237.16,410.9h-121.99C239.91,581.87,479.49,170.89,479.49,170.89h0s240.63,410.03,360.51,617.38h-122.23Z",
  "m633.08,788.85h-309.54c20.61-35.84,40.55-70.52,60.34-104.92h190.22c19.28,34.3,38.47,68.43,58.98,104.92Z",
] as const;
export const OWNED_FAVICON_URL = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 960"><rect width="960" height="960" rx="180" fill="#f0f0f0"/><g fill="#383838" opacity="0.65">${symbolPaths.map((path) => `<path d="${path}"/>`).join("")}</g></svg>`,
)}`;

export function createOwnedFavicon(ownerDocument: Document): { remove(): void } | null {
  if (!ownerDocument.head) return null;
  const link = ownerDocument.createElement("link");
  link.setAttribute("rel", "icon");
  link.setAttribute("type", "image/svg+xml");
  link.setAttribute("sizes", "any");
  link.setAttribute("href", OWNED_FAVICON_URL);
  // Original icon nodes, attributes and ordering remain untouched. No observer
  // fights later site updates, and no page content is saved or transmitted.
  ownerDocument.head.append(link);
  let removed = false;
  return { remove() {
    if (removed) return;
    removed = true;
    if (link.getAttribute("href") === OWNED_FAVICON_URL && link.getAttribute("rel") === "icon") link.remove();
  } };
}
