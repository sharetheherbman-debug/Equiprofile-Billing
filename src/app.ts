import express, { type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import type { BillingConfig } from "./config.js";
import type { Database } from "./db.js";
import { resolvePlan } from "./plans.js";
import { randomToken, tokenHash, verifyConnector } from "./security.js";
import { requireAdmin, requireSession } from "./session.js";
import { createStripeService } from "./stripeService.js";

const html = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>EquiProfile Billing</title><style>body{margin:0;font-family:Inter,system-ui,sans-serif;background:#f5f7fa;color:#10243e}main{max-width:960px;margin:auto;padding:40px 20px}.brand{display:flex;gap:12px;align-items:center}.mark{width:42px;height:42px;border-radius:12px;background:#163563;color:white;display:grid;place-items:center;font-weight:800}.card{margin-top:24px;background:white;border:1px solid #dbe3ea;border-radius:18px;padding:24px;box-shadow:0 10px 30px #10243e12}button,a.button{background:#163563;color:#fff;border:0;border-radius:10px;padding:11px 16px;text-decoration:none;cursor:pointer}.muted{color:#62748a}.row{display:flex;justify-content:space-between;gap:20px;padding:14px 0;border-bottom:1px solid #edf1f4}@media(max-width:600px){.row{display:block}}</style></head><body><main>${body}</main></body></html>`;

export function createApp(config: BillingConfig, db: Database) {
  const app = express();
  const stripeService = createStripeService(config, db);
  const trustedOrigins = new Set([
    new URL(String(config.PUBLIC_URL)).origin,
    new URL(String(config.EQUIPROFILE_CORE_URL)).origin,
  ]);
  const trustedWrite = (req: Request, res: Response, next: () => void) => {
    const origin = String(req.header("Origin") || "");
    if (config.NODE_ENV === "production" && (!origin || !trustedOrigins.has(origin))) {
      return res.status(403).json({ error: "Cross-site request rejected" });
    }
    next();
  };
  app.set("trust proxy", 1);
  app.use(helmet({ contentSecurityPolicy: { directives: { "script-src": ["'self'"] } } }));
  app.use((_req, res, next) => { res.setHeader("X-Robots-Tag", "noindex, nofollow"); next(); });

  app.post("/api/webhooks/stripe", express.raw({ type: "application/json", limit: "2mb" }), async (req, res) => {
    try {
      const signature = String(req.header("stripe-signature") || "");
      if (!signature) return res.status(400).json({ error: "Stripe signature required" });
      const result = await stripeService.handleWebhook(req.body as Buffer, signature);
      res.json({ received: true, ...result });
    } catch {
      res.status(400).json({ error: "Stripe webhook rejected" });
    }
  });

  app.use(express.json({ limit: "256kb" }));
  app.use(cookieParser());

  app.get("/health", async (_req, res) => {
    try { await db.query("SELECT 1"); res.json({ status: "ok", service: "equiprofile-billing" }); }
    catch { res.status(503).json({ status: "unavailable", service: "equiprofile-billing" }); }
  });

  app.post("/api/v1/application-connectors/sso/issue", async (req, res) => {
    const applicationId = String(req.header("X-Application-Id") || "");
    const timestamp = String(req.header("X-Application-Timestamp") || "");
    const nonce = String(req.header("X-Application-Nonce") || "");
    const signature = String(req.header("X-Application-Signature") || "");
    const verified = verifyConnector({
      key: String(config.BILLING_CONNECTOR_KEY),
      expectedApplicationId: String(config.EQUIPROFILE_APP_ID),
      applicationId, timestamp, nonce, signature, body: req.body,
    });
    if (!verified.ok) return res.status(401).json({ success: false, error: { message: "Connector signature rejected" } });
    if (config.NODE_ENV === "production" && !req.secure && String(req.header("X-Forwarded-Proto") || "").toLowerCase() !== "https") {
      return res.status(400).json({ success: false, error: { message: "HTTPS is required" } });
    }
    const externalUserId = String(req.body?.external_user_id || "");
    const email = String(req.body?.email || "").trim().toLowerCase();
    const role = String(req.body?.external_role || "user");
    const product = String(req.body?.product || "");
    const action = String(req.body?.action || "home");
    const plan = req.body?.plan ? String(req.body.plan) : null;
    const interval = req.body?.interval ? String(req.body.interval) : null;
    const organizationId = req.body?.organization_id ? String(req.body.organization_id) : null;
    if (!/^\d+$/.test(externalUserId) || !/^\S+@\S+\.\S+$/.test(email) || !["user", "admin"].includes(role)) return res.status(400).json({ success: false, error: { message: "Invalid account context" } });
    if (!["management", "academy"].includes(product) || !["home", "checkout", "portal"].includes(action)) return res.status(400).json({ success: false, error: { message: "Invalid Billing context" } });
    if (action === "checkout") {
      try {
        const selected = resolvePlan(product, String(plan), String(interval), config);
        if (selected.plan.startsWith("academy_school_") !== Boolean(organizationId)) {
          throw new Error("Invalid organization context");
        }
      }
      catch { return res.status(400).json({ success: false, error: { message: "Invalid or unavailable plan" } }); }
    }
    const code = randomToken(32);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const replay = await client.query("INSERT INTO connector_nonces(application_id,nonce) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING nonce", [applicationId, nonce]);
      if (!replay.rows[0]) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, error: { message: "Connector nonce replay rejected" } }); }
      const user = await client.query(
        `INSERT INTO billing_users(application_id,external_user_id,email,display_name,external_role)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT(application_id,external_user_id) DO UPDATE SET
         email=EXCLUDED.email,display_name=EXCLUDED.display_name,external_role=EXCLUDED.external_role,updated_at=now() RETURNING id`,
        [applicationId, externalUserId, email, String(req.body?.display_name || email).slice(0, 200), role],
      );
      await client.query("INSERT INTO sso_codes(code_hash,user_id,product,action,plan,interval,organization_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '60 seconds')", [tokenHash(code), user.rows[0].id, product, action, plan, interval, organizationId]);
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      return res.status(409).json({ success: false, error: { message: "Could not issue Billing session" } });
    } finally {
      client.release();
    }
    const redirectUrl = `${String(config.PUBLIC_URL).replace(/\/$/, "")}/sso#code=${encodeURIComponent(code)}`;
    res.json({ success: true, data: { redirect_url: redirectUrl, expires_in_seconds: 60 } });
  });

  app.post("/api/v1/sso/consume", trustedWrite, async (req, res) => {
    const code = String(req.body?.code || "");
    if (!/^[A-Za-z0-9_-]{32,160}$/.test(code)) return res.status(400).json({ error: "Invalid launch code" });
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query("SELECT * FROM sso_codes WHERE code_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE", [tokenHash(code)]);
      if (!found.rows[0]) { await client.query("ROLLBACK"); return res.status(401).json({ error: "Launch code expired or already used" }); }
      const session = randomToken(32);
      await client.query("UPDATE sso_codes SET consumed_at=now() WHERE code_hash=$1", [tokenHash(code)]);
      await client.query("INSERT INTO billing_sessions(token_hash,user_id,organization_id,expires_at) VALUES($1,$2,$3,now()+interval '8 hours')", [tokenHash(session), found.rows[0].user_id, found.rows[0].organization_id]);
      await client.query("COMMIT");
      res.cookie("ep_billing_session", session, { httpOnly: true, secure: config.NODE_ENV === "production", sameSite: "lax", maxAge: 8 * 60 * 60 * 1000, path: "/" });
      return res.json({ success: true, action: found.rows[0].action, product: found.rows[0].product, plan: found.rows[0].plan, interval: found.rows[0].interval });
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      return res.status(500).json({ error: "Could not establish Billing session" });
    } finally { client.release(); }
  });

  const session = requireSession(db);
  app.get("/api/entitlements/me", session, async (req, res) => {
    const rows = await db.query("SELECT product_family,plan,status,organization_id,current_period_end,grace_ends_at FROM subscriptions WHERE user_id=$1 ORDER BY product_family,created_at", [req.billingUser!.id]);
    res.json({ entitlements: rows.rows.map((row) => ({ ...row, entitled: ["active", "trialing", "grace"].includes(row.status) || (row.status === "past_due" && row.grace_ends_at && new Date(row.grace_ends_at) > new Date()) })) });
  });
  app.get("/api/subscriptions/me", session, async (req, res) => {
    const rows = await db.query("SELECT id,product_family,plan,billing_interval,organization_id,status,current_period_end,cancel_at_period_end,grace_ends_at FROM subscriptions WHERE user_id=$1 ORDER BY created_at", [req.billingUser!.id]);
    res.json({ subscriptions: rows.rows });
  });
  app.get("/api/invoices/me", session, async (req, res) => {
    const rows = await db.query("SELECT stripe_invoice_id,status,currency,amount_due,amount_paid,hosted_invoice_url,invoice_pdf,created_at FROM invoices WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100", [req.billingUser!.id]);
    res.json({ invoices: rows.rows });
  });
  app.get("/api/subscription-ledger/me", session, async (req, res) => {
    const rows = await db.query("SELECT l.action,l.from_status,l.to_status,l.detail,l.created_at,s.product_family,s.plan FROM subscription_ledger l JOIN subscriptions s ON s.id=l.subscription_id WHERE s.user_id=$1 ORDER BY l.created_at DESC LIMIT 200", [req.billingUser!.id]);
    res.json({ events: rows.rows });
  });
  app.post("/api/checkout", trustedWrite, session, async (req, res) => {
    try { const checkout = await stripeService.checkout(req.billingUser!, req.body); res.json({ checkout_url: checkout.url }); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : "Checkout unavailable" }); }
  });
  app.post("/api/portal", trustedWrite, session, async (req, res) => {
    try { const portal = await stripeService.portal(req.billingUser!, req.body?.return_url); res.json({ portal_url: portal.url }); }
    catch { res.status(409).json({ error: "Customer portal unavailable" }); }
  });
  app.post("/api/subscriptions/:id/cancel", trustedWrite, session, async (req, res) => {
    const current = await db.query("SELECT * FROM subscriptions WHERE id=$1 AND user_id=$2", [req.params.id, req.billingUser!.id]);
    if (!current.rows[0]?.stripe_subscription_id) return res.status(404).json({ error: "Subscription not found" });
    await stripeService.stripe.subscriptions.update(current.rows[0].stripe_subscription_id, { cancel_at_period_end: true });
    await db.query("INSERT INTO subscription_ledger(subscription_id,action,from_status,to_status,detail) VALUES($1,$2,$3,$4,$5)", [req.params.id, "cancellation_requested", current.rows[0].status, current.rows[0].status, JSON.stringify({ cancel_at_period_end: true })]);
    res.json({ success: true, cancel_at_period_end: true });
  });
  app.post("/api/logout", trustedWrite, session, async (req, res) => {
    const token = String(req.cookies?.ep_billing_session || "");
    await db.query("UPDATE billing_sessions SET revoked_at=now() WHERE token_hash=$1", [tokenHash(token)]);
    res.clearCookie("ep_billing_session", { path: "/" });
    res.json({ success: true });
  });

  app.post("/api/admin/refund", trustedWrite, session, requireAdmin, async (req, res) => {
    try { res.json({ refund: await stripeService.refund(req.billingUser!, req.body) }); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : "Refund unavailable" }); }
  });
  app.post("/api/admin/change-subscription", trustedWrite, session, requireAdmin, async (req, res) => {
    try { const result = await stripeService.changeSubscription(req.billingUser!, req.body); res.json({ subscription_id: result.id, status: result.status }); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : "Subscription change unavailable" }); }
  });
  app.post("/api/admin/reconcile", trustedWrite, session, requireAdmin, async (req, res) => {
    const local = await db.query(
      `SELECT s.stripe_subscription_id FROM subscriptions s
       JOIN billing_users u ON u.id=s.user_id
       WHERE s.stripe_subscription_id IS NOT NULL AND u.application_id=$1
       ORDER BY s.updated_at ASC LIMIT 200`,
      [req.billingUser!.application_id],
    );
    let reconciled = 0;
    for (const row of local.rows) {
      const live = await stripeService.stripe.subscriptions.retrieve(row.stripe_subscription_id);
      await stripeService.upsertSubscription(live, `reconcile:${live.id}:${live.created}`);
      reconciled += 1;
    }
    await db.query("INSERT INTO admin_audit_log(actor_user_id,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5)", [req.billingUser!.id, "subscriptions_reconciled", "system", "stripe", JSON.stringify({ reconciled })]);
    res.json({ reconciled });
  });

  app.get("/sso", (_req, res) => res.type("html").send(html(`<div class="brand"><div class="mark">EP</div><div><strong>EquiProfile Billing</strong><div class="muted">Secure account connection</div></div></div><div class="card"><p id="status">Opening your Billing account…</p></div><script src="/sso.js" defer></script>`)));
  app.get("/sso.js", (_req, res) => res.type("application/javascript").send(`(async()=>{const e=document.getElementById('status');const p=new URLSearchParams(location.hash.slice(1));history.replaceState(null,'','/sso');try{const r=await fetch('/api/v1/sso/consume',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:p.get('code')})});if(!r.ok)throw new Error();const c=await r.json();if(c.action==='checkout'){const q=await fetch('/api/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({product:c.product,plan:c.plan,interval:c.interval})});if(!q.ok)throw new Error();const j=await q.json();location.replace(j.checkout_url);return}if(c.action==='portal'){const q=await fetch('/api/portal',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(!q.ok)throw new Error();const j=await q.json();location.replace(j.portal_url);return}location.replace('/account')}catch{e.textContent='This secure Billing link has expired or could not be completed. Return to EquiProfile and open Billing again.'}})();`));
  app.get(["/", "/account"], (_req, res) => res.type("html").send(html(`<div class="brand"><div class="mark">EP</div><div><strong>EquiProfile Billing</strong><div class="muted">Independent subscriptions, one secure account</div></div></div><div class="card"><h1>Your subscriptions</h1><p class="muted">Management and Academy are billed separately. Cancelling one never cancels the other.</p><div id="subscriptions">Loading…</div></div><div class="card"><h2>Invoices and receipts</h2><div id="invoices">Loading…</div></div><script src="/account.js" defer></script>`)));
  app.get("/account.js", (_req, res) => res.type("application/javascript").send(`const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));(async()=>{const [s,i]=await Promise.all([fetch('/api/subscriptions/me'),fetch('/api/invoices/me')]);if(s.status===401){document.getElementById('subscriptions').textContent='Return to EquiProfile and open Billing from your account.';document.getElementById('invoices').textContent='Sign in through EquiProfile to view receipts.';return}const sj=await s.json(),ij=await i.json();document.getElementById('subscriptions').innerHTML=sj.subscriptions.length?sj.subscriptions.map(x=>'<div class="row"><div><strong>'+esc(x.product_family)+' · '+esc(x.plan)+'</strong><div class="muted">'+esc(x.billing_interval)+'</div></div><div>'+esc(x.status)+'</div></div>').join(''):'<p>No active subscriptions yet.</p>';document.getElementById('invoices').innerHTML=ij.invoices.length?ij.invoices.map(x=>'<div class="row"><div>'+esc(x.status)+' · '+esc(x.currency)+'</div><div>'+(Number(x.amount_paid)/100).toFixed(2)+'</div></div>').join(''):'<p>No invoices yet.</p>'})().catch(()=>{document.getElementById('subscriptions').textContent='Billing is temporarily unavailable. Please try again.'});`));

  app.use((_req: Request, res: Response) => res.status(404).json({ error: "Not found" }));
  return app;
}
