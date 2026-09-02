import crypto from "crypto";

export const CONNECTOR_SKEW_SECONDS = 300;

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(",")}}`;
}

export function connectorSignature(key: string, timestamp: string, nonce: string, body: unknown) {
  return crypto.createHmac("sha256", key)
    .update(`${timestamp}\n${nonce}\n${canonicalize(body)}`, "utf8")
    .digest("hex");
}

export function verifyConnector(input: {
  key: string;
  expectedApplicationId: string;
  applicationId: string;
  timestamp: string;
  nonce: string;
  signature: string;
  body: unknown;
  nowSeconds?: number;
}) {
  if (input.key.length < 32) return { ok: false as const, reason: "not_configured" };
  if (input.applicationId !== input.expectedApplicationId) return { ok: false as const, reason: "application" };
  if (!/^[A-Za-z0-9_-]{16,160}$/.test(input.nonce)) return { ok: false as const, reason: "nonce" };
  if (!/^[a-f0-9]{64}$/i.test(input.signature)) return { ok: false as const, reason: "signature" };
  const stamp = Number(input.timestamp);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(stamp) || Math.abs(stamp - now) > CONNECTOR_SKEW_SECONDS) return { ok: false as const, reason: "expired" };
  const expected = Buffer.from(connectorSignature(input.key, input.timestamp, input.nonce, input.body), "hex");
  const supplied = Buffer.from(input.signature, "hex");
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return { ok: false as const, reason: "signature" };
  return { ok: true as const };
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function tokenHash(token: string) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function safeReturnUrl(candidate: unknown, allowedOrigins: string[], fallback: string) {
  try {
    const url = new URL(String(candidate));
    if (url.protocol !== "https:" || !allowedOrigins.includes(url.origin)) return fallback;
    return url.toString();
  } catch {
    return fallback;
  }
}
