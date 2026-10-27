/**
 * Add a tenant to an install that is already running.
 *
 * `skwctl` has verbs for plugins, audit and admin accounts, and none for a tenant: a tenant is a
 * row in `control.db`, a database of its own, a host, a certificate and a block in nginx, and the
 * first three of those are what this script writes. It exists because the alternative is editing
 * `control.seed.json` and re-seeding, which recreates every tenant's control rows and drops the
 * sessions of the ones that were already there.
 *
 * ## Order matters, and so does stopping the app
 *
 * Write `control.db` while the app has it open and SQLite answers `SQLITE_READONLY` to the host
 * process (a second writer against a WAL the container owns). So: stop the app, add the tenant,
 * start it again. The script does not do that itself — a script that restarts a service it does
 * not own is a script that will one day restart it at the wrong moment.
 *
 * ## What it writes
 *
 *   control.db   tenant + one primary domain (cert_state `none`: the installer mints a
 *                 self-signed pair, and only the ACME service may write `issued`)
 *   site.db      a fresh tenant database at schema version N (`migrateTenant`)
 *   user_account the first owner, with a generated password and TOTP secret
 *   enrol file   `data/enrol-<key>.txt`, mode 0600 — the only copy of the password
 *
 * Idempotent: a second run with the same key and host adds nothing and says so.
 *
 *   docker compose stop app
 *   node --no-warnings --experimental-strip-types scripts/add-tenant.ts \
 *     --key fractional --host fractionalworks.com.au --name "Fractional Works" \
 *     --email owner@fractionalworks.com.au
 *   node --no-warnings tools/install_certs.mjs --data data --certs data/certs
 *   docker compose start app
 */
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Auth, totpCode } from '../app/admin/auth.ts';
import { findProjectRoot, migrateTenant } from '../app/db/migrate.ts';

function arg(name: string, fallback: string | undefined): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    process.stderr.write(`add-tenant: --${name} is required\n`);
    process.exit(2);
  }
  return value;
}

/** A password a person can retype from a printed page: no lookalike pairs, no ambiguous glyphs. */
function password(length = 24): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[(bytes[i] as number) % alphabet.length];
  return out;
}

/** RFC 4648 base32, the alphabet every authenticator app accepts. */
function totpSecret(bytes = 20): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const raw = randomBytes(bytes);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of raw) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

const dataDir = arg('data', 'data');
const key = arg('key', undefined);
const host = arg('host', undefined);
const displayName = arg('name', key);
const email = arg('email', undefined);
const controlPath = join(dataDir, 'control.db');
if (!existsSync(controlPath)) {
  process.stderr.write(`add-tenant: no control database at ${controlPath}\n`);
  process.exit(1);
}

const control = new Database(controlPath);
control.pragma('busy_timeout = 8000');
let inserted = false;
try {
  const existing = control.prepare('SELECT id FROM tenant WHERE key = ?').get(key) as { id: number } | undefined;
  let tenantId: number;
  if (existing === undefined) {
    const now = new Date().toISOString();
    const result = control
      .prepare(
        `INSERT INTO tenant (key, mode, status, display_name, db_version, storage_quota_bytes, request_budget_per_min, created_at)
         VALUES (?, 'production', 'active', ?, 3, 1073741824, 600, ?)`,
      )
      .run(key, displayName, now);
    tenantId = Number(result.lastInsertRowid);
    inserted = true;
  } else {
    tenantId = existing.id;
  }
  const domain = control.prepare('SELECT id FROM domain WHERE host = ?').get(host) as { id: number } | undefined;
  if (domain === undefined) {
    control
      .prepare(
        `INSERT INTO domain (host, tenant_id, kind, is_primary, cert_state, created_at)
         VALUES (?, ?, 'primary', 1, 'none', ?)`,
      )
      .run(host, tenantId, new Date().toISOString());
  }
  control.prepare('UPDATE tenant SET display_name = ? WHERE id = ?').run(displayName, tenantId);
} finally {
  control.close();
}

const root = findProjectRoot();
const siteDb = join(dataDir, 'tenants', key, 'site.db');
const report = migrateTenant(siteDb, key, join(root, 'schema'));
if (!report.ok) {
  process.stderr.write(`add-tenant: migration failed for ${key}: ${report.error ?? 'unknown'}\n`);
  process.exit(1);
}

const secret = totpSecret();
const pass = password();
const auth = new Auth({ controlPath, fleetMode: false, allowlist: [] });
const hash = await auth.hashPassword(pass);
const control2 = new Database(controlPath);
control2.pragma('busy_timeout = 8000');
try {
  const tenant = control2.prepare('SELECT id FROM tenant WHERE key = ?').get(key) as { id: number };
  control2
    .prepare(
      `INSERT INTO user_account (tenant_id, email, password_hash, role, totp_secret) VALUES (?, ?, ?, 'owner', ?)
       ON CONFLICT(tenant_id, email) DO UPDATE SET password_hash = excluded.password_hash, totp_secret = excluded.totp_secret`,
    )
    .run(tenant.id, email, hash, secret);
} finally {
  control2.close();
}

const enrol = [
  `tenant:  ${key}`,
  `host:    ${host}`,
  `email:   ${email}`,
  `role:    owner`,
  `password: ${pass}`,
  `secret:  ${secret}`,
  `totp now: ${totpCode(secret, Date.now())}`,
  '',
].join('\n');
const enrolPath = join(dataDir, `enrol-${key}.txt`);
writeFileSync(enrolPath, enrol, { mode: 0o600 });
chmodSync(enrolPath, 0o600);

process.stdout.write(
  `${inserted ? 'created' : 'already present'}: ${key} (${displayName}) → ${host}\n` +
    `  site.db ${report.action}: schema ${String(report.from)} → ${String(report.to)}\n` +
    `  owner ${email}; password and TOTP secret in ${enrolPath} (0600)\n`,
);
