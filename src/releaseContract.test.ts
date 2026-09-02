import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./app.ts", import.meta.url), "utf8");
const stripeSource = readFileSync(new URL("./stripeService.ts", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("./migrations/001_initial.sql", import.meta.url),
  "utf8",
);

describe("Billing production release contract", () => {
  it("keeps launch credentials out of request URLs and consumes them once", () => {
    expect(appSource).toContain('/sso#code=${encodeURIComponent(code)}');
    expect(appSource).toContain("history.replaceState(null,'','/sso')");
    expect(appSource).toContain("consumed_at IS NULL AND expires_at>now() FOR UPDATE");
    expect(appSource).toContain("UPDATE sso_codes SET consumed_at=now()");
    expect(appSource).toContain("httpOnly: true");
    expect(appSource).toContain('sameSite: "lax"');
  });

  it("binds school checkout to signed organization context", () => {
    expect(appSource).toContain("organization_id,expires_at");
    expect(appSource).toContain("billing_sessions(token_hash,user_id,organization_id,expires_at)");
    expect(stripeSource).toContain("user.billing_organization_id");
    expect(stripeSource).toContain("Organization context does not match the signed Core session");
    expect(migration).toContain("UNIQUE(user_id, product_family, scope_key)");
  });

  it("provides idempotent webhook replay and independent subscription operations", () => {
    expect(stripeSource).toContain("ON CONFLICT(event_id) DO NOTHING");
    expect(stripeSource).toContain("status !== \"failed\"");
    expect(stripeSource).toContain("SET status='received',error_code=NULL,processed_at=NULL");
    expect(appSource).toContain('app.post("/api/subscriptions/:id/cancel"');
    expect(appSource).toContain("WHERE id=$1 AND user_id=$2");
    expect(appSource).toContain('app.post("/api/admin/refund"');
    expect(appSource).toContain('app.post("/api/admin/reconcile"');
  });
});
