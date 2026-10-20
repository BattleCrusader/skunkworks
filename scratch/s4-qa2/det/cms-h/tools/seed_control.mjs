#!/usr/bin/env node
/**
 * `schema/control.seed.json` → `control.db`, one transaction (SDS §11.6, E-19).
 *
 * §3's layout names this file `tools/seed_control.py`. The seed needs the same SQLite
 * the image ships and the same CHECK constraints the DDL declares, and the image's
 * runtime is node: so this is `node:sqlite` — the SQLite **inside the Node the bundle
 * already requires**, not a second binding to keep in step with `better-sqlite3` and not
 * the `sqlite3` CLI that a minimal server image does not carry. `install.sh` therefore
 * depends on `node` alone.
 *
 * ## The version gate (S4c)
 *
 * The seed carries `schema_version`. Until S4c nothing read it, while
 * `schema/control.sql` declared `PRAGMA user_version = 4` and the seed still said `3`.
 * That is worse than a mismatch: it is a trap that reads as documentation, and the first
 * code to trust either number would have labelled a v4 database with a v3 seed. The seed
 * now states the version of the DDL it describes and this tool refuses any other —
 * naming both numbers — before it opens a transaction.
 *
 * Three refusals, each because a bundle that carried the value would be a bundle that
 * leaks:
 *   - a user row with a non-NULL `totp_secret` → §11.3's preflight refusal;
 *   - a user row that is not a claim marker (`must_change=1`, no secret);
 *   - a `tenant.mode` other than `production`.
 *
 * Exit 0 on success, 1 on any refusal, 12 on a seed that cannot be read.
 */
import { DatabaseSync } from 'node:sqlite';
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

const db = new DatabaseSync(dbPath, { readOnly: false });
db.exec('PRAGMA foreign_keys = ON');

// --- the version gate: the seed must describe *this* database --------------
const { user_version: dbVersion } = db.prepare('PRAGMA user_version').get();
if (seed.schema_version !== dbVersion) {
  db.close();
  refuse(
    `seed schema_version ${String(seed.schema_version)} does not describe control.db, which is ${String(dbVersion)}` +
      " — a seed and a schema that disagree would label one database with the other's version",
  );
}

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
  db.exec('BEGIN IMMEDIATE');
  try {
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
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
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
