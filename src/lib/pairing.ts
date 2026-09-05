export const MAX_PAIRING_CODE_CHARS = 256;
export const MAX_SERVER_BASE_URL_CHARS = 2_048;

export interface PairingSubmission {
  contract_version: 1;
  server_base_url: string;
  pairing_code: string;
}

export class PairingInputError extends Error {
  constructor(public readonly reasonCode: "INVALID_SERVER_URL" | "INSECURE_SERVER_URL" | "INVALID_PAIRING_CODE") {
    super(reasonCode);
  }
}

const PAIRING_SECRET_SEGMENT = /^[0-9A-HJKMNP-TV-Z]+$/u;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/u;

function isCanonicalPairingCode(value: string): boolean {
  const parts = value.split("-");
  const secretParts = parts.slice(2);
  return parts.length >= 3
    && parts[0] === "A0B1"
    && /^[0-9A-F]{8}$/u.test(parts[1])
    && secretParts.every(
      (part) => part.length > 0
        && (secretParts.length === 1 || part.length <= 8)
        && PAIRING_SECRET_SEGMENT.test(part),
    )
    && secretParts.join("").length === 32;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::1") return true;
  const octets = normalized.split(".");
  return octets.length === 4
    && octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
    && Number(octets[0]) === 127;
}

function safeRawPath(candidate: string): boolean {
  const authorityStart = candidate.indexOf("://");
  const pathStart = authorityStart < 0 ? -1 : candidate.indexOf("/", authorityStart + 3);
  if (pathStart < 0) return true;
  const rawPath = candidate.slice(pathStart);
  if (rawPath.includes("%") || rawPath.includes("//")) return false;
  return rawPath.split("/").filter(Boolean).every(
    (segment) => segment !== "." && segment !== ".." && SAFE_PATH_SEGMENT.test(segment),
  );
}

export function parsePairingSubmission(
  serverBaseUrlValue: unknown,
  pairingCodeValue: unknown,
): PairingSubmission {
  if (
    typeof serverBaseUrlValue !== "string"
    || serverBaseUrlValue.length > MAX_SERVER_BASE_URL_CHARS
  ) {
    throw new PairingInputError("INVALID_SERVER_URL");
  }
  const candidate = serverBaseUrlValue.trim();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new PairingInputError("INVALID_SERVER_URL");
  }
  if (
    !url.hostname
    || (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username
    || url.password
    || url.search
    || url.hash
    || !safeRawPath(candidate)
  ) {
    throw new PairingInputError("INVALID_SERVER_URL");
  }
  if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) {
    throw new PairingInputError("INSECURE_SERVER_URL");
  }

  if (
    typeof pairingCodeValue !== "string"
    || pairingCodeValue.length > MAX_PAIRING_CODE_CHARS
  ) {
    throw new PairingInputError("INVALID_PAIRING_CODE");
  }
  const pairingCode = pairingCodeValue.trim().toUpperCase();
  if (!isCanonicalPairingCode(pairingCode)) {
    throw new PairingInputError("INVALID_PAIRING_CODE");
  }

  const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/u, "");
  return {
    contract_version: 1,
    server_base_url: `${url.origin}${pathname}`,
    pairing_code: pairingCode,
  };
}
