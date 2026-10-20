#!/usr/bin/env node
/**
 * `schema/control.seed.json` → `control.db`, one transaction (SDS §11.6, E-19).
 *
 * §3's layout names this file `tools/seed_control.py`. The seed needs the same
 * SQLite the image ships and the same CHECK constraints the DDL declares, and the
 * image's runtime is node: a python implementation would be a second SQLite binding
 * to keep in step with `better-sqlite3`. Recorded as a layout deviation, not as a
 * behaviour change.
 *
 * Three refusals, each because a bundle that carried the value would be a bundle
 * that leaks:
 *   - a user row with a non-NULL `totp_secret` → §11.3's preflight refusal;
 *   - a user row that is not a claim marker (`must_change=1`, no secret);
 *   - a `tenant.mode` other than `production`.
 *
 * Exit 0 on success, 1 on any refusal, 12 on a seed that cannot be read.
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

const EXIT_REFUSED = 1;
const EXIT_UNREADABLE = 12;

function refuse(message) {
  process.stderr.write(`seed_control: REFUSAL: ${message}\n`);
  process.exit(EXIT_REFUSED);
}

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}

const dbPath = flag('db');
const seedPath = flag('seed');
if (dbPath === undefined || seedPath === undefined) {
  process.stderr.write('usage: seed_control.mjs --db <control.db> --seed <control.seed.json>\n');
  process.exit(EXIT_REFUSED);
}

let seed;
try {
  seed = JSON.parse(readFileSync(seedPath, 'utf8'));
} catch (err) {
  process.stderr.write(`seed_control: cannot read ${seedPath}: ${String(err)}\n`);
  process.exit(EXIT_UNREADABLE);
}

// --- the three refusals, before anything is opened for writing --------------
for (const user of seed.users ?? []) {
  if (user.totp_secret !== null && user.totp_secret !== undefined) {
    refuse('a bundle may not carry a totp_secret (SDS §11.3: a bundle can never ship a working second factor)');
  }
  if (user.must_change !== 1) {
    refuse(`user ${user.email} is not a claim marker: must_change is ${String(user.must_change)}, expected 1`);
  }
}
for (const tenant of seed.tenants ?? []) {
  if (tenant.mode !== 'production') {
    refuse(`tenant ${tenant.key} is mode=${String(tenant.mode)}; a bundle forces production`);
  }
}

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

const insertTenant = db.prepare(
  `INSERT INTO tenant (key, mode, status, display_name, db_version, storage_quota_bytes, request_budget_per_min)
   VALUES (?, ?, ?, ?, 3, ?, ?)`,
);
const insertDomain = db.prepare(
  'INSERT INTO domain (host, tenant_id, kind, is_primary, cert_state) VALUES (?, ?, ?, ?, ?)',
);
const insertUser = db.prepare(
  `INSERT INTO user_account (tenant_id, email, password_hash, role, totp_secret, must_change)
   VALUES (?, ?, ?, ?, NULL, 1)`,
);

try {
  const tx = db.transaction(() => {
    const ids = new Map();
    for (const tenant of seed.tenants ?? []) {
      const info = insertTenant.run(
        tenant.key,
        tenant.mode,
        tenant.status ?? 'active',
        tenant.display_name ?? tenant.key,
        tenant.storage_quota_bytes ?? 1073741824,
        tenant.request_budget_per_min ?? 600,
      );
      ids.set(tenant.key, Number(info.lastInsertRowid));
      for (const host of tenant.hosts ?? []) {
        insertDomain.run(host.host, ids.get(tenant.key), host.kind ?? 'primary', host.is_primary ?? 0, host.cert_state ?? 'none');
      }
    }
    for (const user of seed.users ?? []) {
      const tenantId = ids.get(user.tenant);
      if (tenantId === undefined) refuse(`user ${user.email} names tenant ${user.tenant}, which the seed does not define`);
      insertUser.run(tenantId, user.email, user.password_hash, user.role ?? 'owner');
    }
  });
  tx();
  process.stdout.write(
    `seed_control: ${(seed.tenants ?? []).length} tenant(s), ${(seed.users ?? []).length} claim marker(s), one transaction\n`,
  );
} catch (err) {
  // A failed transaction rolls back in full: a half-seeded control.db is worse
  // than an empty one, because the installer would then bootstrap into it.
  process.stderr.write(`seed_control: REFUSAL: ${String(err)}\n`);
  process.exit(EXIT_REFUSED);
} finally {
  db.close();
}
