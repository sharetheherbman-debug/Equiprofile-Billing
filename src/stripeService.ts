import crypto from "crypto";
import Stripe from "stripe";
import type { BillingConfig } from "./config.js";
import type { Database } from "./db.js";
import { isSchoolPlan, resolvePlan, type ProductFamily } from "./plans.js";
import type { BillingUser } from "./session.js";
import { safeReturnUrl } from "./security.js";
import { syncEntitlementToCore, syncEventId } from "./coreSync.js";

export function createStripeService(config: BillingConfig, db: Database) {
  const stripe = new Stripe(String(config.STRIPE_SECRET_KEY));
  const publicOrigin = new URL(String(config.PUBLIC_URL)).origin;
  const coreOrigin = new URL(String(config.EQUIPROFILE_CORE_URL)).origin;

  async function ensureCustomer(user: BillingUser) {
    if (user.stripe_customer_id) return user.stripe_customer_id;
    const customer = await stripe.customers.create({
      email: user.email,
      name: user.display_name ?? undefined,
      metadata: { application_id: user.application_id, external_user_id: user.external_user_id },
    }, { idempotencyKey: `customer:${user.application_id}:${user.external_user_id}` });
    await db.query("UPDATE billing_users SET stripe_customer_id=$1,updated_at=now() WHERE id=$2", [customer.id, user.id]);
    return customer.id;
  }

  async function checkout(user: BillingUser, input: Record<string, unknown>) {
    const selected = resolvePlan(String(input.product), String(input.plan), String(input.interval), config);
    const requestedOrganizationId = input.organization_id ? String(input.organization_id) : null;
    const organizationId = isSchoolPlan(selected.product, selected.plan)
      ? user.billing_organization_id
      : null;
    if (isSchoolPlan(selected.product, selected.plan) !== Boolean(organizationId)) {
      throw new Error("School plans require an organization; individual plans must not include one");
    }
    if (requestedOrganizationId && requestedOrganizationId !== organizationId) {
      throw new Error("Organization context does not match the signed Core session");
    }
    const existing = await db.query(
      `SELECT id,status FROM subscriptions WHERE user_id=$1 AND product_family=$2
       AND organization_id IS NOT DISTINCT FROM $3 AND status NOT IN ('canceled','cancelled','expired')`,
      [user.id, selected.product, organizationId],
    );
    if (existing.rows[0]) throw new Error("An active subscription already exists for this product context");
    const customer = await ensureCustomer(user);
    const returnUrl = safeReturnUrl(input.return_url, [publicOrigin, coreOrigin], `${publicOrigin}/account`);
    const metadata = {
      application_id: user.application_id,
      user_id: user.external_user_id,
      billing_user_id: user.id,
      product_family: selected.product,
      plan: selected.plan,
      organization_id: organizationId ?? "",
      billing_interval: selected.interval,
    };
    return stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      line_items: [{ price: selected.stripePriceId, quantity: 1 }],
      subscription_data: { metadata, trial_period_days: 7 },
      metadata,
      success_url: `${publicOrigin}/account?checkout=success`,
      cancel_url: returnUrl,
      allow_promotion_codes: true,
    }, { idempotencyKey: `checkout:${user.id}:${selected.product}:${organizationId ?? "individual"}:${selected.plan}:${selected.interval}` });
  }

  async function portal(user: BillingUser, returnCandidate: unknown) {
    const customer = await ensureCustomer(user);
    const returnUrl = safeReturnUrl(returnCandidate, [publicOrigin, coreOrigin], `${publicOrigin}/account`);
    return stripe.billingPortal.sessions.create({ customer, return_url: returnUrl });
  }

  async function upsertSubscription(subscription: Stripe.Subscription, stripeEventId: string) {
    const metadata = subscription.metadata;
    const billingUserId = metadata.billing_user_id;
    const productValue = String(metadata.product_family || "");
    const plan = String(metadata.plan || "");
    const organizationId = metadata.organization_id || null;
    const interval = String(metadata.billing_interval || "");
    if (!billingUserId || !["management", "academy"].includes(productValue) || !plan || !["monthly", "yearly"].includes(interval)) {
      throw new Error("Stripe subscription metadata is incomplete");
    }
    const product = productValue as ProductFamily;
    resolvePlan(product, plan, interval, config);
    if (isSchoolPlan(product, plan) !== Boolean(organizationId)) throw new Error("Stripe subscription product context is invalid");
    const userResult = await db.query("SELECT * FROM billing_users WHERE id=$1", [billingUserId]);
    const user = userResult.rows[0] as BillingUser | undefined;
    if (!user || user.external_user_id !== metadata.user_id) throw new Error("Stripe subscription user does not match Billing account");
    const item = subscription.items.data[0];
    if (!item) throw new Error("Stripe subscription has no price item");
    const expected = resolvePlan(product, plan, interval, config);
    if (item.price.id !== expected.stripePriceId) throw new Error("Stripe price is outside the server allowlist");
    const currentStart = new Date(item.current_period_start * 1000);
    const currentEnd = new Date(item.current_period_end * 1000);
    const prior = await db.query(
      "SELECT id,status FROM subscriptions WHERE user_id=$1 AND product_family=$2 AND organization_id IS NOT DISTINCT FROM $3",
      [user.id, product, organizationId],
    );
    const saved = await db.query(
      `INSERT INTO subscriptions(user_id,product_family,plan,billing_interval,organization_id,scope_key,stripe_subscription_id,stripe_price_id,status,current_period_start,current_period_end,cancel_at_period_end,grace_ends_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT(user_id,product_family,scope_key) DO UPDATE SET
       plan=EXCLUDED.plan,billing_interval=EXCLUDED.billing_interval,stripe_subscription_id=EXCLUDED.stripe_subscription_id,
       stripe_price_id=EXCLUDED.stripe_price_id,status=EXCLUDED.status,current_period_start=EXCLUDED.current_period_start,
       current_period_end=EXCLUDED.current_period_end,cancel_at_period_end=EXCLUDED.cancel_at_period_end,
       grace_ends_at=EXCLUDED.grace_ends_at,updated_at=now() RETURNING *`,
      [user.id, product, plan, interval, organizationId, organizationId ?? "individual", subscription.id, item.price.id, subscription.status, currentStart, currentEnd, subscription.cancel_at_period_end, subscription.status === "past_due" ? new Date(Date.now() + 3 * 86_400_000) : null],
    );
    const row = saved.rows[0];
    await db.query(
      "INSERT INTO subscription_ledger(subscription_id,stripe_event_id,action,from_status,to_status,detail) VALUES($1,$2,$3,$4,$5,$6)",
      [row.id, stripeEventId, "stripe_subscription_reconciled", prior.rows[0]?.status ?? null, subscription.status, JSON.stringify({ product, plan, interval, organization_id: organizationId })],
    );
    await syncEntitlementToCore(config, {
      event_id: syncEventId(stripeEventId, subscription.id),
      external_user_id: Number(user.external_user_id),
      product,
      status: subscription.status,
      plan,
      interval,
      organization_id: organizationId ? Number(organizationId) : null,
      current_period_ends_at: currentEnd.toISOString(),
      stripe_customer_id: String(subscription.customer),
      stripe_subscription_id: subscription.id,
    });
    return row;
  }

  async function storeInvoice(invoice: Stripe.Invoice) {
    const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
    if (!customerId) return;
    const user = await db.query("SELECT id FROM billing_users WHERE stripe_customer_id=$1", [customerId]);
    if (!user.rows[0]) return;
    const parentSubscription = invoice.parent?.subscription_details?.subscription;
    const stripeSubscriptionId = typeof parentSubscription === "string" ? parentSubscription : parentSubscription?.id;
    const sub = stripeSubscriptionId ? await db.query("SELECT id FROM subscriptions WHERE stripe_subscription_id=$1", [stripeSubscriptionId]) : null;
    await db.query(
      `INSERT INTO invoices(stripe_invoice_id,user_id,subscription_id,status,currency,amount_due,amount_paid,hosted_invoice_url,invoice_pdf,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(stripe_invoice_id) DO UPDATE SET status=EXCLUDED.status,amount_due=EXCLUDED.amount_due,
       amount_paid=EXCLUDED.amount_paid,hosted_invoice_url=EXCLUDED.hosted_invoice_url,invoice_pdf=EXCLUDED.invoice_pdf,updated_at=now()`,
      [invoice.id, user.rows[0].id, sub?.rows[0]?.id ?? null, invoice.status ?? "unknown", invoice.currency.toUpperCase(), invoice.amount_due, invoice.amount_paid, invoice.hosted_invoice_url, invoice.invoice_pdf, new Date(invoice.created * 1000)],
    );
  }

  async function handleWebhook(rawBody: Buffer, signature: string) {
    const event = stripe.webhooks.constructEvent(rawBody, signature, String(config.STRIPE_WEBHOOK_SECRET));
    const payloadHash = crypto.createHash("sha256").update(rawBody).digest("hex");
    const inserted = await db.query(
      "INSERT INTO stripe_events(event_id,event_type,payload_hash) VALUES($1,$2,$3) ON CONFLICT(event_id) DO NOTHING RETURNING event_id",
      [event.id, event.type, payloadHash],
    );
    if (!inserted.rows[0]) {
      const existing = await db.query("SELECT status FROM stripe_events WHERE event_id=$1", [event.id]);
      if (existing.rows[0]?.status !== "failed") return { duplicate: true };
      await db.query("UPDATE stripe_events SET status='received',error_code=NULL,processed_at=NULL WHERE event_id=$1", [event.id]);
    }
    try {
      if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
        await upsertSubscription(event.data.object as Stripe.Subscription, event.id);
      }
      if (["invoice.paid", "invoice.payment_failed", "invoice.finalized", "invoice.voided"].includes(event.type)) {
        await storeInvoice(event.data.object as Stripe.Invoice);
      }
      await db.query("UPDATE stripe_events SET status='processed',processed_at=now() WHERE event_id=$1", [event.id]);
      return { duplicate: false };
    } catch (error) {
      await db.query("UPDATE stripe_events SET status='failed',error_code=$2,processed_at=now() WHERE event_id=$1", [event.id, error instanceof Error ? error.name : "processing_error"]);
      throw error;
    }
  }

  async function changeSubscription(actor: BillingUser, input: Record<string, unknown>) {
    const subscriptionId = String(input.subscription_id || "");
    const current = await db.query(
      `SELECT s.* FROM subscriptions s
       JOIN billing_users u ON u.id=s.user_id
       WHERE s.id=$1 AND u.application_id=$2`,
      [subscriptionId, actor.application_id],
    );
    const row = current.rows[0];
    if (!row?.stripe_subscription_id) throw new Error("Subscription not found");
    const selected = resolvePlan(row.product_family, String(input.plan), String(input.interval), config);
    const live = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
    const item = live.items.data[0];
    if (!item) throw new Error("Subscription item not found");
    const updated = await stripe.subscriptions.update(live.id, {
      items: [{ id: item.id, price: selected.stripePriceId }],
      proration_behavior: "create_prorations",
      metadata: { ...live.metadata, plan: selected.plan, billing_interval: selected.interval },
    });
    await db.query("INSERT INTO admin_audit_log(actor_user_id,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5)", [actor.id, "subscription_changed", "subscription", subscriptionId, JSON.stringify({ plan: selected.plan, interval: selected.interval })]);
    return updated;
  }

  async function refund(actor: BillingUser, input: Record<string, unknown>) {
    const paymentIntent = String(input.payment_intent_id || "");
    if (!/^pi_[A-Za-z0-9]+$/.test(paymentIntent)) throw new Error("Invalid payment intent");
    const amount = input.amount_pence === undefined ? undefined : Number(input.amount_pence);
    if (amount !== undefined && (!Number.isInteger(amount) || amount < 1)) throw new Error("Invalid refund amount");
    const intent = await stripe.paymentIntents.retrieve(paymentIntent);
    const customerId = typeof intent.customer === "string" ? intent.customer : intent.customer?.id;
    if (!customerId) throw new Error("Payment does not belong to a Billing customer");
    const ownedCustomer = await db.query(
      "SELECT id FROM billing_users WHERE application_id=$1 AND stripe_customer_id=$2 LIMIT 1",
      [actor.application_id, customerId],
    );
    if (!ownedCustomer.rows[0]) throw new Error("Payment does not belong to this application");
    const result = await stripe.refunds.create({ payment_intent: paymentIntent, ...(amount ? { amount } : {}), metadata: { actor_user_id: actor.external_user_id } }, { idempotencyKey: String(input.idempotency_key || `refund:${paymentIntent}:${amount ?? "full"}`) });
    await db.query("INSERT INTO admin_audit_log(actor_user_id,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5)", [actor.id, "refund_created", "payment_intent", paymentIntent, JSON.stringify({ refund_id: result.id, amount: result.amount })]);
    return result;
  }

  return { stripe, checkout, portal, handleWebhook, changeSubscription, refund, upsertSubscription };
}
