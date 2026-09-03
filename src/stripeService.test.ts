import { beforeEach, describe, expect, it, vi } from "vitest";

const stripe = vi.hoisted(() => ({
  customersCreate: vi.fn(),
  checkoutCreate: vi.fn(),
  portalCreate: vi.fn(),
  subscriptionRetrieve: vi.fn(),
  subscriptionUpdate: vi.fn(),
  paymentIntentRetrieve: vi.fn(),
  refundCreate: vi.fn(),
  constructEvent: vi.fn(),
}));

vi.mock("stripe", () => ({
  default: class StripeMock {
    customers = { create: stripe.customersCreate };
    checkout = { sessions: { create: stripe.checkoutCreate } };
    billingPortal = { sessions: { create: stripe.portalCreate } };
    subscriptions = { retrieve: stripe.subscriptionRetrieve, update: stripe.subscriptionUpdate };
    paymentIntents = { retrieve: stripe.paymentIntentRetrieve };
    refunds = { create: stripe.refundCreate };
    webhooks = { constructEvent: stripe.constructEvent };
  },
}));

import { createStripeService } from "./stripeService.js";

const config = {
  NODE_ENV: "test",
  PUBLIC_URL: "https://billing.equiprofile.online",
  EQUIPROFILE_CORE_URL: "https://equiprofile.online",
  EQUIPROFILE_APP_ID: "equiprofile",
  BILLING_CONNECTOR_KEY: "k".repeat(48),
  STRIPE_SECRET_KEY: "sk_test_fixture",
  STRIPE_WEBHOOK_SECRET: "whsec_fixture",
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
} as any;

const individual = {
  id: "billing-user-1",
  application_id: "equiprofile",
  external_user_id: "42",
  email: "rider@example.test",
  display_name: "Test Rider",
  external_role: "user",
  stripe_customer_id: "cus_fixture",
  billing_organization_id: null,
};

const schoolAdmin = {
  ...individual,
  id: "billing-user-2",
  external_user_id: "84",
  external_role: "admin",
  billing_organization_id: "school-17",
};

beforeEach(() => {
  vi.clearAllMocks();
  stripe.checkoutCreate.mockResolvedValue({ id: "cs_fixture", url: "https://checkout.stripe.test/session" });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
});

describe("Stripe Billing service boundaries", () => {
  it("creates independent Management and Academy checkouts using only allowlisted prices", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) } as any;
    const service = createStripeService(config, db);

    await service.checkout(individual, {
      product: "management",
      plan: "management_pro",
      interval: "monthly",
      return_url: "https://equiprofile.online/admin",
    });
    await service.checkout(individual, {
      product: "academy",
      plan: "academy_rider",
      interval: "yearly",
      return_url: "https://equiprofile.online/academy",
    });

    expect(stripe.checkoutCreate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      line_items: [{ price: "price_managementProMonthly", quantity: 1 }],
      metadata: expect.objectContaining({ product_family: "management", plan: "management_pro", organization_id: "" }),
    }), expect.objectContaining({ idempotencyKey: expect.stringContaining(":management:individual:") }));
    expect(stripe.checkoutCreate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      line_items: [{ price: "price_academyRiderYearly", quantity: 1 }],
      metadata: expect.objectContaining({ product_family: "academy", plan: "academy_rider", organization_id: "" }),
    }), expect.objectContaining({ idempotencyKey: expect.stringContaining(":academy:individual:") }));
  });

  it("binds Academy school checkout to the organization in the signed Billing session", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) } as any;
    const service = createStripeService(config, db);

    await service.checkout(schoolAdmin, {
      product: "academy",
      plan: "academy_school_20",
      interval: "monthly",
      organization_id: "school-17",
    });
    expect(stripe.checkoutCreate).toHaveBeenCalledWith(expect.objectContaining({
      line_items: [{ price: "price_academySchool20Monthly", quantity: 1 }],
      metadata: expect.objectContaining({ product_family: "academy", organization_id: "school-17" }),
    }), expect.objectContaining({ idempotencyKey: expect.stringContaining(":academy:school-17:") }));

    await expect(service.checkout(schoolAdmin, {
      product: "academy",
      plan: "academy_school_20",
      interval: "monthly",
      organization_id: "different-school",
    })).rejects.toThrow("Organization context does not match");
    await expect(service.checkout(individual, {
      product: "academy",
      plan: "academy_school_20",
      interval: "monthly",
    })).rejects.toThrow("School plans require an organization");
  });

  it("processes a signed subscription event once and sends only its paid product entitlement to Core", async () => {
    const eventStatus = new Map<string, string>();
    const queries: string[] = [];
    const db = {
      query: vi.fn(async (sql: string, values: unknown[]) => {
        queries.push(sql);
        if (sql.startsWith("INSERT INTO stripe_events")) {
          if (eventStatus.has(String(values[0]))) return { rows: [] };
          eventStatus.set(String(values[0]), "received");
          return { rows: [{ event_id: values[0] }] };
        }
        if (sql.startsWith("SELECT status FROM stripe_events")) return { rows: [{ status: eventStatus.get(String(values[0])) }] };
        if (sql.startsWith("UPDATE stripe_events SET status='processed'")) {
          eventStatus.set(String(values[0]), "processed");
          return { rows: [] };
        }
        if (sql.startsWith("SELECT * FROM billing_users")) return { rows: [individual] };
        if (sql.startsWith("SELECT id,status FROM subscriptions")) return { rows: [] };
        if (sql.startsWith("INSERT INTO subscriptions")) return { rows: [{ id: "sub-local-1", status: "active" }] };
        return { rows: [] };
      }),
    } as any;
    stripe.constructEvent.mockReturnValue({
      id: "evt_subscription_1",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_stripe_1",
          customer: "cus_fixture",
          status: "active",
          cancel_at_period_end: false,
          metadata: {
            application_id: "equiprofile",
            user_id: "42",
            billing_user_id: individual.id,
            product_family: "management",
            plan: "management_pro",
            organization_id: "",
            billing_interval: "monthly",
          },
          items: { data: [{ price: { id: "price_managementProMonthly" }, current_period_start: 1_788_285_600, current_period_end: 1_790_877_600 }] },
        },
      },
    });
    const service = createStripeService(config, db);

    await expect(service.handleWebhook(Buffer.from("signed-event"), "stripe-signature")).resolves.toEqual({ duplicate: false });
    await expect(service.handleWebhook(Buffer.from("signed-event"), "stripe-signature")).resolves.toEqual({ duplicate: true });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://equiprofile.online/api/v1/billing-sync/entitlements");
    expect(JSON.parse(String(request?.body))).toMatchObject({
      external_user_id: 42,
      product: "management",
      status: "active",
      plan: "management_pro",
      organization_id: null,
      stripe_subscription_id: "sub_stripe_1",
    });
    expect(request?.headers).toEqual(expect.objectContaining({
      "X-Application-Id": "equiprofile",
      "X-Application-Signature": expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(queries.filter((sql) => sql.startsWith("INSERT INTO subscriptions"))).toHaveLength(1);
  });

  it("rejects webhook subscription prices outside the server allowlist before persisting entitlement", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith("SELECT * FROM billing_users")) return { rows: [individual] };
        if (sql.startsWith("SELECT id,status FROM subscriptions")) return { rows: [] };
        return { rows: [] };
      }),
    } as any;
    const service = createStripeService(config, db);
    const subscription = {
      id: "sub_tampered",
      customer: "cus_fixture",
      status: "active",
      cancel_at_period_end: false,
      metadata: {
        user_id: "42",
        billing_user_id: individual.id,
        product_family: "academy",
        plan: "academy_rider",
        organization_id: "",
        billing_interval: "monthly",
      },
      items: { data: [{ price: { id: "price_not_allowlisted" }, current_period_start: 1_788_285_600, current_period_end: 1_790_877_600 }] },
    } as any;

    await expect(service.upsertSubscription(subscription, "evt_tampered")).rejects.toThrow("outside the server allowlist");
    expect(fetch).not.toHaveBeenCalled();
    expect(db.query.mock.calls.some(([sql]: [string]) => sql.startsWith("INSERT INTO subscriptions"))).toBe(false);
  });
});
