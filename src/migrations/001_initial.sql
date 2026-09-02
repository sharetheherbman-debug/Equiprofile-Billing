CREATE TABLE IF NOT EXISTS billing_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id varchar(80) NOT NULL,
  external_user_id varchar(120) NOT NULL,
  email varchar(320) NOT NULL,
  display_name varchar(200),
  external_role varchar(32) NOT NULL DEFAULT 'user',
  stripe_customer_id varchar(255),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(application_id, external_user_id),
  UNIQUE(application_id, email)
);

CREATE TABLE IF NOT EXISTS connector_nonces (
  application_id varchar(80) NOT NULL,
  nonce varchar(160) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(application_id, nonce)
);

CREATE TABLE IF NOT EXISTS sso_codes (
  code_hash char(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES billing_users(id),
  product varchar(32) NOT NULL,
  action varchar(32) NOT NULL,
  plan varchar(80),
  interval varchar(16),
  organization_id varchar(120),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_sessions (
  token_hash char(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES billing_users(id),
  organization_id varchar(120),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES billing_users(id),
  product_family varchar(32) NOT NULL,
  plan varchar(80) NOT NULL,
  billing_interval varchar(16) NOT NULL,
  organization_id varchar(120),
  scope_key varchar(120) NOT NULL DEFAULT 'individual',
  stripe_subscription_id varchar(255) UNIQUE,
  stripe_price_id varchar(255) NOT NULL,
  status varchar(32) NOT NULL,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  grace_ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, product_family, scope_key)
);

CREATE TABLE IF NOT EXISTS stripe_events (
  event_id varchar(255) PRIMARY KEY,
  event_type varchar(120) NOT NULL,
  payload_hash char(64) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'received',
  error_code varchar(120),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE TABLE IF NOT EXISTS subscription_ledger (
  id bigserial PRIMARY KEY,
  subscription_id uuid REFERENCES subscriptions(id),
  stripe_event_id varchar(255),
  action varchar(80) NOT NULL,
  from_status varchar(32),
  to_status varchar(32),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoices (
  stripe_invoice_id varchar(255) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES billing_users(id),
  subscription_id uuid REFERENCES subscriptions(id),
  status varchar(32) NOT NULL,
  currency char(3) NOT NULL,
  amount_due bigint NOT NULL,
  amount_paid bigint NOT NULL,
  hosted_invoice_url text,
  invoice_pdf text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id bigserial PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES billing_users(id),
  action varchar(100) NOT NULL,
  target_type varchar(60) NOT NULL,
  target_id varchar(255) NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscriptions_user_product_idx ON subscriptions(user_id, product_family);
CREATE INDEX IF NOT EXISTS ledger_subscription_idx ON subscription_ledger(subscription_id, created_at DESC);
CREATE INDEX IF NOT EXISTS invoices_user_idx ON invoices(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS connector_nonces_created_idx ON connector_nonces(created_at);
CREATE INDEX IF NOT EXISTS sso_codes_expiry_idx ON sso_codes(expires_at);
CREATE INDEX IF NOT EXISTS billing_sessions_expiry_idx ON billing_sessions(expires_at);
