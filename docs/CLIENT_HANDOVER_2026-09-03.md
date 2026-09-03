# EquiProfile Billing client handover — 2026-09-03

## Release identity

- Repository: `sharetheherbman-debug/Equiprofile-Billing`
- Branch: `chatgpt/final-client-handover-2026-09-02`
- Audited starting SHA: `d1dc171549bae84635bc0eba8a9a27e0984ed09c`
- Release-code SHA: `c0ab6cc0453c481795dea31e5e65cb6bc948d080`
- The documentation commit follows the release-code SHA; use the final PR head for the complete handover tree.

## Product and architecture

This is the only central EquiProfile Billing service. It owns the Stripe customer, checkout, portal, subscription, invoice, refund, webhook-event and audit-ledger boundary for both Management and Academy. Management and Academy plans are independent subscriptions sharing a customer account; cancellation or failure in one product does not remove the other.

The service uses a dedicated PostgreSQL schema (one idempotent initial migration), Express, server-side Stripe SDK calls, and a signed Core entitlement callback. Core remains the source of truth for complimentary grants and administrator overlays; Billing sync sends only paid subscription state.

## Security and SSO

Core issues a timestamped, nonced HMAC request. Billing persists nonce replay protection and returns a 60-second one-time code in the URL fragment, consumes it under a row lock, removes it from browser history, and exchanges it for an HTTP-only, same-site secure production cookie. Write requests are origin restricted in production. Return URLs are allowlisted.

Checkout accepts only the exact server-side Management or Academy plan/interval catalog and configured Stripe price IDs. Academy school plans are bound to the organisation carried by the signed session. Webhooks require Stripe signature verification, persist a payload hash/event ID, and replay only previously failed events. Core sync uses its own signed nonce and deterministic event ID.

Required deployment variables are documented in `.env.example`: dedicated `DATABASE_URL`, session/connector secrets, Stripe secret/webhook key, public/Core origins and all exact price IDs. Do not copy secrets into documentation or client code.

## Verification evidence

Executed with Node 22 against the release-code tree:

- `npm run check` — PASS.
- `npm test` — 3 files, 10 passed, 0 failed.
- `npm run build` — PASS.
- `npm audit --audit-level=high` — 0 vulnerabilities.
- `git diff --check` — PASS.
- The executable suite covers connector signature/expiry/mutation, safe return origins, all 12 exact catalog amounts, cross-product allowlist rejection, independent Management/Academy checkout metadata, school-organisation binding, webhook duplicate replay, signed paid-entitlement sync and tampered Stripe price rejection.
- The package has no separate lint script; TypeScript strict checking plus the changed-code whitespace gate are the applicable local code-quality checks.

A live Stripe webhook/provider journey was not performed because this source-completion task has no production credentials and forbids production mutation. CI must pass on the final pushed SHA. After deployment approval, use Stripe test mode first, replay the same event, verify one local subscription/ledger transition, and confirm Management/Academy and complimentary/admin isolation in Core.

## Deployment, rollback and external blocker

Do not deploy from this task. After branch/CI review: verify or create the dedicated database, apply `001_initial.sql`, populate only already-audited Stripe price IDs, configure the matching Core connector secret and webhook endpoint, deploy behind HTTPS, then execute signed SSO and Stripe test-mode replay acceptance. Preserve the database backup and previous artifact for rollback.

`billing.equiprofile.online` DNS is outside source control. Until independently verified, record **BLOCKED — EXTERNAL DNS** and do not claim the Billing service is live. No DNS change was made here.

Do not casually add billing pages back to Core, merge Management and Academy entitlement rows, accept browser-selected price IDs, weaken organisation binding, erase complimentary/admin overlays, or make webhook processing non-idempotent.

