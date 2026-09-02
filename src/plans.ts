export type ProductFamily = "management" | "academy";
export type BillingInterval = "monthly" | "yearly";

export const PLAN_CATALOG = {
  management: {
    management_pro: { monthly: 1000, yearly: 10000 },
    management_stable: { monthly: 3000, yearly: 30000 },
  },
  academy: {
    academy_rider: { monthly: 800, yearly: 8000 },
    academy_school_10: { monthly: 4900, yearly: 49000 },
    academy_school_20: { monthly: 8900, yearly: 89000 },
    academy_school_50: { monthly: 19900, yearly: 199000 },
  },
} as const;

export type PlanKey = keyof typeof PLAN_CATALOG.management | keyof typeof PLAN_CATALOG.academy;

const PRICE_KEYS: Record<ProductFamily, Record<string, Record<BillingInterval, string>>> = {
  management: {
    management_pro: { monthly: "STRIPE_PRICE_MANAGEMENT_PRO_MONTHLY", yearly: "STRIPE_PRICE_MANAGEMENT_PRO_YEARLY" },
    management_stable: { monthly: "STRIPE_PRICE_MANAGEMENT_STABLE_MONTHLY", yearly: "STRIPE_PRICE_MANAGEMENT_STABLE_YEARLY" },
  },
  academy: {
    academy_rider: { monthly: "STRIPE_PRICE_ACADEMY_RIDER_MONTHLY", yearly: "STRIPE_PRICE_ACADEMY_RIDER_YEARLY" },
    academy_school_10: { monthly: "STRIPE_PRICE_ACADEMY_SCHOOL_10_MONTHLY", yearly: "STRIPE_PRICE_ACADEMY_SCHOOL_10_YEARLY" },
    academy_school_20: { monthly: "STRIPE_PRICE_ACADEMY_SCHOOL_20_MONTHLY", yearly: "STRIPE_PRICE_ACADEMY_SCHOOL_20_YEARLY" },
    academy_school_50: { monthly: "STRIPE_PRICE_ACADEMY_SCHOOL_50_MONTHLY", yearly: "STRIPE_PRICE_ACADEMY_SCHOOL_50_YEARLY" },
  },
};

export function resolvePlan(
  product: string,
  plan: string,
  interval: string,
  env: Record<string, string | number>,
): { product: ProductFamily; plan: string; interval: BillingInterval; amountPence: number; stripePriceId: string; priceEnvKey: string } {
  if (product !== "management" && product !== "academy") throw new Error("Invalid product family");
  if (interval !== "monthly" && interval !== "yearly") throw new Error("Invalid billing interval");
  const priceKey = PRICE_KEYS[product][plan]?.[interval];
  const amount = (PLAN_CATALOG[product] as Record<string, Record<BillingInterval, number>>)[plan]?.[interval];
  if (!priceKey || !amount) throw new Error("Plan is not in the server allowlist");
  const stripePriceId = String(env[priceKey] || "").trim();
  if (!/^price_[A-Za-z0-9]+$/.test(stripePriceId)) throw new Error("Stripe price is not configured");
  return { product, plan, interval, amountPence: amount, stripePriceId, priceEnvKey: priceKey };
}

export function isSchoolPlan(product: ProductFamily, plan: string) {
  return product === "academy" && plan.startsWith("academy_school_");
}
