# EquiProfile Billing

Standalone Billing service for `billing.equiprofile.online`. Management and Academy subscriptions remain independent while sharing one customer account and Stripe customer record.

## Security and ownership

- Core launches Billing through HMAC SHA-256 signed server communication with timestamp, nonce, application identity, canonical body, replay persistence and a 60-second one-time browser handoff.
- The handoff token is placed in the URL fragment, so it is not sent in HTTP request URLs or ordinary proxy logs. It is consumed once through a POST and exchanged for an HTTP-only secure session cookie.
- Stripe prices are selected only from the server-side allowlist. Return URLs are restricted to the Billing and EquiProfile origins.
- Webhooks require Stripe signature verification and unique event persistence.
- Billing updates only paid subscription state in Core. Core retains complimentary grants and administrator roles independently.

## API

- `GET /api/entitlements/me`
- `GET /api/subscriptions/me`
- `GET /api/invoices/me`
- `GET /api/subscription-ledger/me`
- `POST /api/checkout`
- `POST /api/portal`
- `POST /api/subscriptions/:id/cancel`
- `POST /api/admin/refund`
- `POST /api/admin/change-subscription`
- `POST /api/admin/reconcile`
- `POST /api/webhooks/stripe`
- `POST /api/v1/application-connectors/sso/issue`

Run the additive PostgreSQL migration with `npm run migrate`, then start the service behind HTTPS reverse proxying to `127.0.0.1:3100`. Audit existing Stripe products first and populate only the matching price IDs; do not create duplicate Management prices.
