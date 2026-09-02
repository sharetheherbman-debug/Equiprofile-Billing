import crypto from "crypto";
import type { BillingConfig } from "./config.js";
import { canonicalize, connectorSignature, randomToken } from "./security.js";

export async function syncEntitlementToCore(config: BillingConfig, body: Record<string, unknown>) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomToken(24);
  const signature = connectorSignature(String(config.BILLING_CONNECTOR_KEY), timestamp, nonce, body);
  const response = await fetch(`${String(config.EQUIPROFILE_CORE_URL).replace(/\/$/, "")}/api/v1/billing-sync/entitlements`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Application-Id": String(config.EQUIPROFILE_APP_ID),
      "X-Application-Timestamp": timestamp,
      "X-Application-Nonce": nonce,
      "X-Application-Signature": signature,
    },
    body: canonicalize(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Core entitlement synchronization failed (${response.status})`);
}

export function syncEventId(stripeEventId: string, subscriptionId: string) {
  return crypto.createHash("sha256").update(`${stripeEventId}:${subscriptionId}`).digest("hex");
}
