/**
 * The index-audit gate — every query on the request path must be a SEARCH.
 *
 * The defect this gate exists for: `app/admin/auth.ts` authenticates with
 * `WHERE email = ?`, and the only index on `user_account(email)` was
 * `ux_user_email_global ... WHERE tenant_id IS NULL` — partial, and therefore
 * usable only by the fleet operator. Every tenant admin login scanned the whole
 * table. The same shape existed for `domain(tenant_id)`: `ux_domain_primary` is
 * partial on `is_primary = 1`, so listing one tenant's hosts scanned.
 *
 * A plan is a property of the *schema*, and it changes silently: a dropped index
 * makes a query slower and every functional test still passes. So the plan is
 * asserted here, against the DDL the image ships (`schema/site.sql`,
 * `schema/control.sql`), for a fixed list of the queries the request path runs.
 *
 * ## Why a fixed list, and what keeps it honest
 *
 * `EXPLAIN QUERY PLAN` needs the statement text, so the list is a transcription.
 * Each entry names the file:line it was taken from, and the two entries this slice
 * indexes carry their index's name and shape as an assertion of their own — if the
 * index is dropped from `gen_schema.py`, the gate goes red twice: once on the plan
 * and once naming the missing index.
 *
 * ## The allowlist, and why each entry is legitimate
 *
 * A `SCAN` is not always a defect. Two shapes are legitimate and are enumerated
 * here rather than tolerated by a regex:
 *
 *   1. `ORDER BY ts DESC LIMIT n` over `cms_audit`. The plan reads
 *      "SCAN cms_audit USING INDEX ix_ca_ts" — SQLite walks `ix_ca_ts` backwards
 *      and stops after n rows. There is no temp b-tree and no table walk: the
 *      `SCAN` keyword describes the index traversal, not a row scan of the table.
 *      `audit.newest` asserts the absence of `USE TEMP B-TREE` as well, because
 *      that is the thing that would make the word "SCAN" true.
 *   2. A query with **no predicate** whose whole table is the answer:
 *      `SELECT ... FROM tenant` and `SELECT host, tenant_id FROM domain` in
 *      `app/tenancy/cache.ts` load the routing table at boot and on a revision
 *      bump. These are the control plane's registry tables — one row per tenant
 *      and one per host, a documented small set (SDS §5.3) — and there is no
 *      predicate to seek on. An index cannot improve "read every row".
 *
 * An allowlist entry that stops matching a SCAN is a failure too ("stale
 * allowlist"): an entry that no longer describes reality is a comment pretending
 * to be a control, and the next reader would trust it.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { REPO, SCHEMA } from './helpers/fixture.ts';

type Plane = 'site' | 'control';

interface AuditedQuery {
  /** The name a red run prints. Stable: the report cites it. */
  name: string;
  plane: Plane;
  /** Where the statement is written, so a transcription can be re-checked. */
  source: string;
  sql: string;
  /** Bind values. `EXPLAIN QUERY PLAN` does not execute, but the count must match. */
  params: unknown[];
}

/**
 * The request path, in the order a request walks it: tenancy -> page -> render ->
 * assets -> download -> forms -> plugins -> audit. Statements transcribed from the
 * modules named in `source`; the leading whitespace of the originals is not kept.
 */
const QUERIES: readonly AuditedQuery[] = [
  // --- control plane: every request starts here -------------------------------------
  {
    name: 'tenant.by_key',
    plane: 'control',
    source: 'app/tenancy/cache.ts:89',
    sql: 'SELECT id, key, mode, status, db_version FROM tenant WHERE key = ?',
    params: ['acme'],
  },
  {
    name: 'control.tenants_all',
    plane: 'control',
    source: 'app/tenancy/cache.ts:89',
    sql: 'SELECT id, key, mode, status, db_version FROM tenant',
    params: [],
  },
  {
    name: 'domain.by_host',
    plane: 'control',
    source: 'app/tenancy/cache.ts:92',
    sql: 'SELECT host, tenant_id FROM domain WHERE host = ?',
    params: ['acme.test'],
  },
  {
    name: 'control.domains_all',
    plane: 'control',
    source: 'app/tenancy/cache.ts:92',
    sql: 'SELECT host, tenant_id FROM domain',
    params: [],
  },
  {
    name: 'domain.by_tenant',
    plane: 'control',
    source: 'app/cli/export.ts:117',
    sql: `SELECT host, kind, is_primary, cert_state FROM domain
           WHERE tenant_id = (SELECT id FROM tenant WHERE key = ?)
           ORDER BY is_primary DESC, host`,
    params: ['acme'],
  },
  {
    name: 'login.by_email',
    plane: 'control',
    source: 'app/admin/auth.ts:267',
    sql: `SELECT id, tenant_id, email, password_hash, role, totp_secret, failed_logins, locked_until
            FROM user_account
           WHERE email = ?`,
    params: ['owner@acme.test'],
  },
  {
    name: 'user.by_id',
    plane: 'control',
    source: 'app/admin/auth.ts:240',
    sql: 'SELECT id, tenant_id, email, role FROM user_account WHERE id = ?',
    params: [1],
  },
  {
    name: 'session.by_id',
    plane: 'control',
    source: 'app/admin/session.ts:222',
    sql: 'SELECT id, user_id, tenant_id, csrf_secret FROM session WHERE id = ?',
    params: ['0'.repeat(64)],
  },
  {
    name: 'session.by_user',
    plane: 'control',
    source: 'app/admin/session.ts',
    sql: 'SELECT id FROM session WHERE user_id = ?',
    params: [1],
  },
  {
    name: 'audit_log.tenant_ts',
    plane: 'control',
    source: 'app/audit/scheduler.ts',
    sql: 'SELECT id, ts FROM audit_log WHERE tenant_id = ? ORDER BY ts DESC LIMIT 50',
    params: [1],
  },

  // --- site plane: the render path ---------------------------------------------------
  {
    name: 'render.page_by_path',
    plane: 'site',
    source: 'app/render/page.ts:58',
    sql: `SELECT id, path, title, status, template, body_html, body_css, updated_at
            FROM cms_page
           WHERE path = ? AND status = 'published'
           LIMIT 1`,
    params: ['/pricing'],
  },
  {
    name: 'render.page_by_path_preview',
    plane: 'site',
    source: 'app/render/preview.ts:127',
    sql: `SELECT id, path, title, status, template, body_html, body_css, updated_at
            FROM cms_page WHERE path = ? LIMIT 1`,
    params: ['/pricing'],
  },
  {
    name: 'render.nav_by_location',
    plane: 'site',
    source: 'app/render/nav.ts',
    sql: `SELECT id, parent_id, label, href_kind, href_target, position
            FROM cms_nav
           WHERE location = ? AND visible = 1
           ORDER BY ifnull(parent_id, 0), position`,
    params: ['header'],
  },
  {
    name: 'page.status_listing',
    plane: 'site',
    source: 'app/admin/crud.ts',
    sql: 'SELECT id, path FROM cms_page WHERE status = ? ORDER BY published_at DESC',
    params: ['draft'],
  },

  // --- site plane: assets ------------------------------------------------------------
  {
    name: 'asset.by_key',
    plane: 'site',
    source: 'app/assets/library.ts:56',
    sql: 'SELECT id, key, filename, mime, bytes, sha256 FROM cms_asset WHERE key = ?',
    params: ['work/one'],
  },
  {
    name: 'asset.by_id',
    plane: 'site',
    source: 'app/assets/library.ts:60',
    sql: 'SELECT id, key, filename, mime, bytes, sha256 FROM cms_asset WHERE id = ?',
    params: [1],
  },
  {
    name: 'asset.by_sha',
    plane: 'site',
    source: 'app/assets/library.ts',
    sql: 'SELECT id, key FROM cms_asset WHERE sha256 = ?',
    params: ['0'.repeat(64)],
  },
  {
    name: 'asset.by_kind',
    plane: 'site',
    source: 'app/assets/library.ts',
    sql: 'SELECT id, key FROM cms_asset WHERE kind = ? ORDER BY created_at DESC',
    params: ['image'],
  },
  {
    name: 'asset.variants',
    plane: 'site',
    source: 'app/assets/renditions.ts',
    sql: 'SELECT label, format, width, height, storage_path FROM cms_asset_variant WHERE asset_id = ?',
    params: [1],
  },
  {
    name: 'asset.links',
    plane: 'site',
    source: 'app/assets/links.ts',
    sql: 'SELECT owner_kind, owner_id FROM cms_asset_link WHERE asset_id = ?',
    params: [1],
  },
  {
    name: 'asset.link_owner',
    plane: 'site',
    source: 'app/assets/links.ts',
    sql: 'SELECT asset_id FROM cms_asset_link WHERE owner_kind = ? AND owner_id = ?',
    params: ['page', 1],
  },

  // --- site plane: the download plane ------------------------------------------------
  {
    name: 'code.by_selector',
    plane: 'site',
    source: 'app/download/plane.ts:327',
    sql: `SELECT id, asset_id, bundle_id, code_hash, max_uses, uses, expires_at, revoked_at
            FROM cms_download_code WHERE code_selector = ?`,
    params: ['ABCD'],
  },
  {
    name: 'event.by_jti',
    plane: 'site',
    source: 'app/download/ledger.ts:159',
    sql: "SELECT outcome, code_id, asset_id FROM cms_download_event WHERE jti = ? AND kind = 'first'",
    params: ['0'.repeat(32)],
  },
  {
    name: 'event.count_by_code',
    plane: 'site',
    source: 'app/download/ledger.ts:213',
    sql: "SELECT COUNT(*) AS n FROM cms_download_event WHERE code_id = ? AND kind = 'first'",
    params: [1],
  },
  {
    name: 'event.by_code_ts',
    plane: 'site',
    source: 'app/download/ledger.ts',
    sql: 'SELECT id, ts FROM cms_download_event WHERE code_id = ? ORDER BY ts DESC LIMIT 10',
    params: [1],
  },
  {
    name: 'watermark.expired',
    plane: 'site',
    source: 'app/download/render.ts:715',
    sql: 'SELECT id, path FROM cms_watermark_render WHERE expires_at <= ?',
    params: ['2026-01-01T00:00:00.000Z'],
  },
  {
    name: 'watermark.by_hashes',
    plane: 'site',
    source: 'app/download/render.ts:547',
    sql: 'SELECT id, path FROM cms_watermark_render WHERE spec_sha = ? AND source_sha = ?',
    params: ['0'.repeat(64), '0'.repeat(64)],
  },

  // --- site plane: settings, forms, plugins, audit -----------------------------------
  {
    name: 'settings.by_key',
    plane: 'site',
    source: 'app/download/plane.ts:682',
    sql: 'SELECT value_json FROM cms_settings WHERE key = ?',
    params: ['download.continuation_grace_s'],
  },
  {
    name: 'form.by_key',
    plane: 'site',
    source: 'app/forms/intake.ts:217',
    sql: 'SELECT id, key, title, fields_json, mode, action_url FROM cms_form WHERE key = ?',
    params: ['contact'],
  },
  {
    name: 'datasource.by_key',
    plane: 'site',
    source: 'app/sources/registry.ts',
    sql: 'SELECT id, spec_json FROM cms_datasource WHERE key = ?',
    params: ['products'],
  },
  {
    name: 'datasource.public',
    plane: 'site',
    source: 'app/sources/registry.ts',
    sql: 'SELECT id, key FROM cms_datasource WHERE is_public = 1',
    params: [],
  },
  {
    name: 'plugin.enabled',
    plane: 'site',
    source: 'app/plugins/runtime.ts:640',
    sql: 'SELECT plugin_id, version, manifest_json FROM cms_plugin_installed WHERE enabled = 1 ORDER BY id',
    params: [],
  },
  {
    name: 'plugin.by_id',
    plane: 'site',
    source: 'app/plugins/runtime.ts:316',
    sql: 'SELECT id, enabled FROM cms_plugin_installed WHERE plugin_id = ?',
    params: ['notes'],
  },
  {
    name: 'plugin_setting.by_plugin',
    plane: 'site',
    source: 'app/plugins/context.ts',
    sql: 'SELECT value_json FROM cms_plugin_setting WHERE plugin_id = ?',
    params: ['notes'],
  },
  {
    name: 'audit.newest',
    plane: 'site',
    source: 'app/audit/chain.ts',
    sql: 'SELECT id, ts, action FROM cms_audit ORDER BY ts DESC LIMIT 50',
    params: [],
  },
  {
    name: 'audit.by_action',
    plane: 'site',
    source: 'app/admin/routes.ts',
    sql: 'SELECT id FROM cms_audit WHERE action = ? ORDER BY ts DESC LIMIT 50',
    params: ['page.save'],
  },
];

/**
 * The two legitimate SCAN shapes, enumerated. The value is the reason a reader
 * needs; the gate also requires the entry to still describe a real SCAN.
 */
const ALLOWLIST: Readonly<Record<string, string>> = {
  'audit.newest':
    'ORDER BY ts DESC LIMIT 50: SQLite walks ix_ca_ts backwards and stops after 50 rows. ' +
    'The plan says SCAN because the index is traversed end to end in the chosen direction — ' +
    'there is no table walk and no temp b-tree (asserted below).',
  'control.tenants_all':
    'No predicate: the tenancy cache loads every tenant row at boot and on a revision bump. ' +
    '`tenant` is the control-plane registry, a documented small set (SDS §5.3); an index ' +
    'cannot improve reading every row.',
  'control.domains_all':
    'No predicate: the same cache load for the host -> tenant routing table. One row per ' +
    'host, a documented small set; an index cannot improve reading every row.',
};

function openPlane(plane: Plane): Database.Database {
  const db = new Database(':memory:');
  db.exec(readFileSync(join(SCHEMA, plane === 'site' ? 'site.sql' : 'control.sql'), 'utf8'));
  return db;
}

interface Plan {
  text: string;
  hasScan: boolean;
  hasTempBTree: boolean;
}

function planOf(db: Database.Database, query: AuditedQuery): Plan {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params) as { detail: string }[];
  const text = rows.map((r) => r.detail).join(' | ');
  return { text, hasScan: /\bSCAN\b/.test(text), hasTempBTree: /USE TEMP B-TREE/.test(text) };
}

/**
 * Run the audit. The return value is what a red run prints: one line per failure,
 * each naming the query and quoting the plan SQLite produced. Pure (a database in,
 * failures out) so the negative control below can drive it with a crippled schema.
 */
function audit(db: Database.Database, queries: readonly AuditedQuery[]): string[] {
  const failures: string[] = [];
  for (const query of queries) {
    const plan = planOf(db, query);
    const reason = ALLOWLIST[query.name];
    if (plan.hasScan && reason === undefined) {
      failures.push(`${query.name}: SCAN (expected SEARCH) — plan: ${plan.text} [${query.source}]`);
      continue;
    }
    if (plan.hasScan && reason !== undefined && plan.hasTempBTree) {
      // The allowlist explains an index walk, not "sort the table first". A temp
      // b-tree means the row set is materialised, which the reason does not cover.
      failures.push(`${query.name}: allowlisted SCAN gained USE TEMP B-TREE — plan: ${plan.text}`);
    }
    if (!plan.hasScan && reason !== undefined) {
      failures.push(
        `${query.name}: stale allowlist entry — the query SEARCHes now (${plan.text}); remove the entry`,
      );
    }
  }
  return failures;
}

const site = openPlane('site');
const control = openPlane('control');

test('every core runtime query SEARCHes — a SCAN fails with the query name and the plan', () => {
  const failures = [
    ...audit(site, QUERIES.filter((q) => q.plane === 'site')),
    ...audit(control, QUERIES.filter((q) => q.plane === 'control')),
  ];
  assert.deepEqual(failures, [], `index audit: ${failures.length} SCAN(s)\n${failures.join('\n')}`);
});

test('the audit covers the whole request path, not a token few queries', () => {
  // A gate that silently lost its list would still pass. The count is the witness,
  // and the two planes are both represented.
  assert.ok(QUERIES.length >= 35, `only ${QUERIES.length} queries are audited`);
  assert.ok(QUERIES.some((q) => q.plane === 'site'));
  assert.ok(QUERIES.some((q) => q.plane === 'control'));
  const names = new Set(QUERIES.map((q) => q.name));
  assert.equal(names.size, QUERIES.length, 'a duplicated query name makes a red run ambiguous');
});

test('the allowlist is small, documented and still describes a real SCAN', () => {
  const allowed = Object.keys(ALLOWLIST);
  assert.equal(allowed.length, 3, 'exactly three allowlisted shapes: ix_ca_ts backwards, and the two cache loads');
  for (const name of allowed) {
    const reason = ALLOWLIST[name] ?? '';
    assert.ok(reason.trim().length >= 80, `${name}: the reason is a sentence, not a shrug`);
    assert.ok(reason.trim().endsWith('.'), `${name}: the reason ends with a full stop, not mid-thought`);
    const query = QUERIES.find((q) => q.name === name);
    assert.ok(query !== undefined, `${name}: allowlisted but not audited`);
    const db = query.plane === 'site' ? site : control;
    assert.equal(planOf(db, query).hasScan, true, `${name}: stale allowlist entry — it SEARCHes now`);
  }
  // The audit-order query is the one whose allowlisting depends on the index walk
  // rather than on the table being small: no temp b-tree, or the reason is false.
  const newest = QUERIES.find((q) => q.name === 'audit.newest') as AuditedQuery;
  assert.equal(planOf(site, newest).hasTempBTree, false, 'audit.newest must walk ix_ca_ts, not sort it');
  assert.match(planOf(site, newest).text, /USING INDEX ix_ca_ts/);
});

test('the login index is non-unique on purpose', () => {
  const indexes = control.prepare("PRAGMA index_list('user_account')").all() as {
    name: string;
    unique: number;
    partial: number;
  }[];
  const email = indexes.find((i) => i.name === 'ix_user_email');
  assert.ok(email !== undefined, 'ix_user_email is missing from user_account (login scans)');
  assert.equal(email.unique, 0, 'ix_user_email must NOT be unique: two rows with one email are refused as ambiguous by the app, not by a constraint');
  assert.equal(email.partial, 0, 'ix_user_email must not be partial: tenant admins are the rows it exists for');
  const cols = (control.prepare("PRAGMA index_info('ix_user_email')").all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(cols, ['email']);
});

test('the domain index covers the listing predicate and its order', () => {
  const indexes = control.prepare("PRAGMA index_list('domain')").all() as { name: string; unique: number }[];
  const tenant = indexes.find((i) => i.name === 'ix_domain_tenant');
  assert.ok(tenant !== undefined, 'ix_domain_tenant is missing from domain (listing scans)');
  assert.equal(tenant.unique, 0, 'ix_domain_tenant is a listing index, not a constraint');
  const cols = (control.prepare("PRAGMA index_info('ix_domain_tenant')").all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(cols, ['tenant_id', 'is_primary', 'host'], 'the index must also satisfy ORDER BY is_primary DESC, host');
});

// --- the negative control --------------------------------------------------------------
//
// A gate nobody has seen fail is a gate nobody knows works. This drops each new
// index from a scratch copy of the same DDL and requires the audit to go red
// *naming that query* — the failure a real regression would print.

test('negative control — dropping ix_user_email makes the audit red, naming login.by_email', () => {
  const scratch = openPlane('control');
  scratch.exec('DROP INDEX ix_user_email');
  const failures = audit(scratch, QUERIES.filter((q) => q.plane === 'control'));
  assert.equal(failures.length, 1, `expected exactly one failure, got:\n${failures.join('\n')}`);
  assert.match(failures[0] as string, /^login\.by_email: SCAN/);
  assert.match(failures[0] as string, /SCAN user_account/, 'the failure must quote the plan');
});

test('negative control — dropping ix_domain_tenant makes the audit red, naming domain.by_tenant', () => {
  const scratch = openPlane('control');
  scratch.exec('DROP INDEX ix_domain_tenant');
  const failures = audit(scratch, QUERIES.filter((q) => q.plane === 'control'));
  assert.equal(failures.length, 1, `expected exactly one failure, got:\n${failures.join('\n')}`);
  assert.match(failures[0] as string, /^domain\.by_tenant: SCAN/);
  assert.match(failures[0] as string, /SCAN domain/, 'the failure must quote the plan');
});
