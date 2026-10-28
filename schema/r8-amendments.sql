-- r8-amendments.sql — the v7 -> v8 delta for a tenant site.db.
--
-- Applies to a site.db at PRAGMA user_version = 7 and yields 8, which is the shape
-- schema/site.sql now generates. Convergence on the fresh DDL is asserted by
-- scripts/model/verify_claims.py check 20 (table set, column set, trigger set, index set and the
-- canonical table text), so this file and the generator cannot drift without `make test` failing.
--
-- WHAT THIS ADDS AND WHY (S9, docs/sds/03-jobboard.md)
--
--   The board's people: cms_account, cms_account_role, cms_account_token, cms_account_session,
--   cms_profile — and the mail the board sends on their behalf, cms_mail and cms_mail_suppression.
--
--   Identity lives in the TENANT's file rather than control.db on purpose. The public
--   registration path must never share a table with the fleet's operator accounts: separate
--   tables, separate cookie, separate path. Three decisions are expressed as constraints rather
--   than as handler code, because a constraint cannot be forgotten:
--
--     * cms_account.status = 'active' is unrepresentable without email_verified = 1 AND a
--       non-NULL totp_confirmed_at. Activation is not a step a handler remembers to perform.
--     * cms_profile has NO contact column. What an advertiser may see is projected by
--       app/accounts/policy.ts, and a projection cannot leak a field the table does not have.
--     * cms_mail.idempotency_key is UNIQUE, so a retried enqueue is the same message.
--
--   Nothing existing is touched: seven tables, their indexes, and a version pragma. No rebuild,
--   no backfill — a tenant with no accounts simply has no rows.

CREATE TABLE cms_account (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL COLLATE NOCASE CHECK(email LIKE '%_@_%.__%'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','suspended','closed')),
  password_hash TEXT NOT NULL CHECK(length(password_hash) BETWEEN 20 AND 400),
  totp_secret TEXT NOT NULL CHECK(length(totp_secret) BETWEEN 16 AND 128),
  totp_confirmed_at TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK(email_verified IN (0,1)),
  failed_logins INTEGER NOT NULL DEFAULT 0 CHECK(failed_logins >= 0),
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT ux_account_email UNIQUE(email),
  CHECK(status <> 'active' OR email_verified = 1),
  CHECK(status <> 'active' OR totp_confirmed_at IS NOT NULL)
);

CREATE INDEX ix_account_status ON cms_account(status);

CREATE TABLE cms_account_role (
  account_id INTEGER NOT NULL REFERENCES cms_account(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('applicant','advertiser')),
  granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(account_id, role)
);

CREATE INDEX ix_role_role ON cms_account_role(role);

CREATE TABLE cms_account_token (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES cms_account(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK(purpose IN ('verify_email','reset_password')),
  token_hash TEXT NOT NULL CHECK(length(token_hash) = 64),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  ip_hash TEXT NOT NULL CHECK(length(ip_hash) = 64),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT ux_account_token_hash UNIQUE(token_hash),
  CHECK(consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX ix_token_account ON cms_account_token(account_id, purpose);

CREATE INDEX ix_account_token_expiry ON cms_account_token(expires_at);

CREATE TABLE cms_account_session (
  id TEXT PRIMARY KEY CHECK(length(id) = 64),
  account_id INTEGER NOT NULL REFERENCES cms_account(id) ON DELETE CASCADE,
  csrf_secret TEXT NOT NULL CHECK(length(csrf_secret) BETWEEN 32 AND 128),
  ip_hash TEXT NOT NULL CHECK(length(ip_hash) = 64),
  ua_hash TEXT NOT NULL CHECK(length(ua_hash) = 64),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  rotated_from TEXT,
  revoked_at TEXT
);

CREATE INDEX ix_account_session_account ON cms_account_session(account_id);

CREATE INDEX ix_account_session_expiry ON cms_account_session(expires_at);

CREATE TABLE cms_profile (
  account_id INTEGER PRIMARY KEY REFERENCES cms_account(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 120),
  headline TEXT,
  summary TEXT,
  skills_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(skills_json)),
  day_rate_cents INTEGER CHECK(day_rate_cents IS NULL OR day_rate_cents > 0),
  currency TEXT NOT NULL DEFAULT 'AUD' CHECK(length(currency) = 3),
  availability_days_per_week INTEGER CHECK(availability_days_per_week IS NULL OR availability_days_per_week BETWEEN 1 AND 7),
  location TEXT,
  timezone TEXT,
  remote_ok INTEGER NOT NULL DEFAULT 0 CHECK(remote_ok IN (0,1)),
  links_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(links_json)),
  visibility TEXT NOT NULL DEFAULT 'hidden' CHECK(visibility IN ('hidden','discoverable')),
  notify_new_jobs INTEGER NOT NULL DEFAULT 0 CHECK(notify_new_jobs IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX ix_profile_discovery ON cms_profile(visibility, notify_new_jobs);

CREATE TABLE cms_mail (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email TEXT NOT NULL CHECK(to_email LIKE '%_@_%.__%'),
  template TEXT NOT NULL CHECK(length(template) BETWEEN 1 AND 64),
  subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 200),
  vars_json TEXT NOT NULL CHECK(json_valid(vars_json)),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','failed','suppressed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at TEXT,
  last_error TEXT,
  provider_id TEXT,
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 200),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at TEXT,
  CONSTRAINT ux_mail_idempotency UNIQUE(idempotency_key)
);

CREATE INDEX ix_mail_queue ON cms_mail(status, next_attempt_at);

CREATE INDEX ix_mail_created ON cms_mail(created_at);

CREATE TABLE cms_mail_suppression (
  email TEXT PRIMARY KEY COLLATE NOCASE CHECK(email LIKE '%_@_%.__%'),
  reason TEXT NOT NULL CHECK(reason IN ('bounce','complaint','unsubscribe','manual')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

PRAGMA user_version = 8;
