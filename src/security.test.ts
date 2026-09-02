import { describe, expect, it } from "vitest";
import { connectorSignature, safeReturnUrl, verifyConnector } from "./security.js";
import { resolvePlan } from "./plans.js";

describe("Billing connector security", () => {
  const key = "k".repeat(48);
  const body = { product: "academy", plan: "rider", external_user_id: "42" };
  const timestamp = "1788285600";
  const nonce = "nonce_1234567890abcdef";

  it("accepts canonical HMAC and rejects expiry or mutation", () => {
    const signature = connectorSignature(key, timestamp, nonce, body);
    expect(verifyConnector({ key, expectedApplicationId: "equiprofile", applicationId: "equiprofile", timestamp, nonce, signature, body, nowSeconds: 1788285600 })).toEqual({ ok: true });
    expect(verifyConnector({ key, expectedApplicationId: "equiprofile", applicationId: "equiprofile", timestamp, nonce, signature, body, nowSeconds: 1788286200 })).toMatchObject({ ok: false, reason: "expired" });
    expect(verifyConnector({ key, expectedApplicationId: "equiprofile", applicationId: "equiprofile", timestamp, nonce, signature, body: { ...body, product: "management" }, nowSeconds: 1788285600 })).toMatchObject({ ok: false, reason: "signature" });
  });

  it("enforces return origins and the exact server-side price allowlist", () => {
    expect(safeReturnUrl("https://evil.example/steal", ["https://equiprofile.online"], "https://equiprofile.online/admin")).toBe("https://equiprofile.online/admin");
    const env = { STRIPE_PRICE_ACADEMY_RIDER_MONTHLY: "price_riderMonthly" };
    expect(resolvePlan("academy", "academy_rider", "monthly", env)).toMatchObject({ amountPence: 800, stripePriceId: "price_riderMonthly" });
    expect(() => resolvePlan("academy", "academy_school_enterprise", "monthly", env)).toThrow("server allowlist");
    expect(() => resolvePlan("management", "academy_rider", "monthly", env)).toThrow("server allowlist");
  });

  it("keeps every Management and Academy price exact and product-scoped", () => {
    const env = {
      STRIPE_PRICE_MANAGEMENT_PRO_MONTHLY: "price_managementProMonthly",
      STRIPE_PRICE_MANAGEMENT_PRO_YEARLY: "price_managementProYearly",
      STRIPE_PRICE_MANAGEMENT_STABLE_MONTHLY: "price_managementStableMonthly",
      STRIPE_PRICE_MANAGEMENT_STABLE_YEARLY: "price_managementStableYearly",
      STRIPE_PRICE_ACADEMY_RIDER_MONTHLY: "price_academyRiderMonthly",
      STRIPE_PRICE_ACADEMY_RIDER_YEARLY: "price_academyRiderYearly",
      STRIPE_PRICE_ACADEMY_SCHOOL_10_MONTHLY: "price_academySchool10Monthly",
      STRIPE_PRICE_ACADEMY_SCHOOL_10_YEARLY: "price_academySchool10Yearly",
      STRIPE_PRICE_ACADEMY_SCHOOL_20_MONTHLY: "price_academySchool20Monthly",
      STRIPE_PRICE_ACADEMY_SCHOOL_20_YEARLY: "price_academySchool20Yearly",
      STRIPE_PRICE_ACADEMY_SCHOOL_50_MONTHLY: "price_academySchool50Monthly",
      STRIPE_PRICE_ACADEMY_SCHOOL_50_YEARLY: "price_academySchool50Yearly",
    };
    expect([
      resolvePlan("management", "management_pro", "monthly", env).amountPence,
      resolvePlan("management", "management_pro", "yearly", env).amountPence,
      resolvePlan("management", "management_stable", "monthly", env).amountPence,
      resolvePlan("management", "management_stable", "yearly", env).amountPence,
      resolvePlan("academy", "academy_rider", "monthly", env).amountPence,
      resolvePlan("academy", "academy_rider", "yearly", env).amountPence,
      resolvePlan("academy", "academy_school_10", "monthly", env).amountPence,
      resolvePlan("academy", "academy_school_10", "yearly", env).amountPence,
      resolvePlan("academy", "academy_school_20", "monthly", env).amountPence,
      resolvePlan("academy", "academy_school_20", "yearly", env).amountPence,
      resolvePlan("academy", "academy_school_50", "monthly", env).amountPence,
      resolvePlan("academy", "academy_school_50", "yearly", env).amountPence,
    ]).toEqual([1000, 10000, 3000, 30000, 800, 8000, 4900, 49000, 8900, 89000, 19900, 199000]);
  });
});
