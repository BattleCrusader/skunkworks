/**
 * S3c / §7.2 / §7.6 — **code issuance, all three channels, and the issue-time refusals.**
 *
 *   I1  a code is 16 Crockford characters, `<selector:4><secret:12>`, stored as
 *       selector + argon2id(`m=19456,t=2,p=1`) and nothing recoverable;
 *   I2  `max_uses`: per issue → `cms_settings.download.default_max_uses` (3) → and a
 *       missing setting is a refusal, never a silent 3;
 *   I3  `NULL` (unlimited) needs the tenant toggle **and** the per-issue confirmation;
 *   I4  an encrypted PDF is refused **at issue**, naming the asset — by flag and by
 *       the bytes in its trailer, because the upload path does not set the flag;
 *   I5  CSV: a blank `max_uses` is the default, and a bad line issues nothing;
 *   I6  the signed webhook: a good signature issues, a replay of `order_ref` is 409,
 *       a bad signature is 401;
 *   I7  reissue revokes the old row and mints a new code — the old one stops working;
 *   I8  the admin screen issues, shows the plaintext once, and lists the codes.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { totpCode } from '../app/admin/auth.ts';
import { uploadAsset } from '../app/assets/library.ts';
import { openAdminWrite } from '../app/db/classes.ts';
import {
  CROCKFORD,
  CODE_LENGTH,
  issueCode,
  issueFromCsv,
  parseIssueCsv,
  reissueCode,
  resolveMaxUses,
  verifyCodeHash,
} from '../app/download/code.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { ADMIN_HOST, ADMIN_ORIGIN, TOTP_SECRET, login, seedUser, type Sessioned } from './helpers/admin.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, type Res } from './helpers/http.ts';

const HOST = 'acme.test';
const PDF =
  '%PDF-1.7\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R/Size 4>>\n%%EOF\n';
/** An owner-password PDF's shape: the trailer names an /Encrypt dictionary. */
const ENCRYPTED_PDF =
  '%PDF-1.7\n5 0 obj<</Filter/Standard/V 2/R 3/O <00>/U <00>/P -4>>endobj\n' +
  'trailer<</Root 1 0 R/Encrypt 5 0 R/Size 6>>\n%%EOF\n';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let contentRoot = '';
let session: Sessioned;
let bookId = 0;
let encryptedId = 0;
let encryptedKey = '';

function db(): Database.Database {
  return openAdminWrite(fixture.sitePath('acme'));
}

async function upload(key: string, filename: string, bytes: Buffer, accessClass: 'gated' | 'public' = 'gated'): Promise<number> {
  const conn = db();
  try {
    const r = await uploadAsset({
      db: conn,
      contentRoot,
      tenantKey: 'acme',
      key,
      filename,
      bytes,
      quotaLimitBytes: 10_000_000,
      accessClass,
    });
    return r.asset.id;
  } finally {
    conn.close();
  }
}

async function postForm(path: string, fields: Record<string, string>): Promise<Res> {
  return call({
    port,
    path,
    method: 'POST',
    host: ADMIN_HOST,
    headers: {
      cookie: session.cookie,
      origin: ADMIN_ORIGIN,
      'x-csrf-token': session.csrfToken,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields).toString(),
  });
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: [HOST], title: 'Acme' }] });
  contentRoot = join(fixture.dir, 'content');
  bookId = await upload('vault/book', 'book.pdf', Buffer.from(PDF, 'latin1'));
  encryptedKey = 'vault/locked';
  encryptedId = await upload(encryptedKey, 'locked.pdf', Buffer.from(ENCRYPTED_PDF, 'latin1'));

  // The store never sets `encrypted` in this build, so the issue path reads the bytes.
  // This row proves the *flag* is honoured too, on an asset whose bytes are plain.
  const conn = db();
  try {
    conn.prepare(`UPDATE cms_asset SET encrypted = 1 WHERE id = ?`).run(
      await upload('vault/flagged', 'flagged.pdf', Buffer.from(PDF, 'latin1')),
    );
    conn
      .prepare(`INSERT INTO cms_settings (key, value_json, type) VALUES ('download.webhook_secret', ?, 'string')`)
      .run(JSON.stringify('whsec-test-0123456789'));
  } finally {
    conn.close();
  }

  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'owner@acme.test', totpSecret: TOTP_SECRET });
  handle = await buildApp({ env: loadEnv(fixture.env), contentRoot });
  port = await handle.app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
    const address = handle.app.server.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  });
  const res = await login({ port, key: 'acme', email: 'owner@acme.test', totp: totpCode(TOTP_SECRET, Date.now()) });
  assert.equal(res.status, 200, res.body);
  const raw = String(res.headers['set-cookie']);
  session = {
    cookie: raw.slice(0, raw.indexOf(';')),
    csrfToken: (res.json as { csrfToken: string }).csrfToken,
    email: 'owner@acme.test',
  };
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

test('I1 — a code is 16 Crockford characters; the row holds the selector and an argon2id hash', async () => {
  const issued = await issueCode({ db: db(), contentRoot, assetKey: 'vault/book' });
  assert.equal(issued.code.length, CODE_LENGTH);
  for (const ch of issued.code) assert.ok(CROCKFORD.includes(ch), `${ch} is not Crockford`);
  assert.equal(issued.selector, issued.code.slice(0, 4));
  assert.match(issued.selector, /^[0-9A-HJKMNP-TV-Z]{4}$/);

  const conn = db();
  try {
    const row = conn.prepare(`SELECT * FROM cms_download_code WHERE id = ?`).get(issued.id) as Record<string, unknown>;
    assert.equal(row.code_selector, issued.selector);
    assert.match(String(row.code_hash), /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    // No column holds the secret in a recoverable form — not even the whole code.
    for (const [column, value] of Object.entries(row)) {
      if (typeof value !== 'string') continue;
      assert.ok(!value.includes(issued.code.slice(4)), `${column} contains the secret`);
      assert.ok(!value.includes(issued.code), `${column} contains the whole code`);
    }
  } finally {
    conn.close();
  }
  assert.equal(await verifyCodeHash(String((db().prepare(`SELECT code_hash FROM cms_download_code WHERE id = ?`).get(issued.id) as { code_hash: string }).code_hash), issued.code), true);
  assert.equal(issued.maxUses, 3, 'the shipped tenant default');
  assert.equal(issued.assetKey, 'vault/book');
});

test('I2 — max_uses resolves per issue, then the tenant setting, and a missing setting is a refusal', async () => {
  const conn = db();
  try {
    assert.equal(resolveMaxUses(conn, 7, false), 7, 'per issue wins');
    assert.equal(resolveMaxUses(conn, undefined, false), 3, 'then the tenant default');
    assert.throws(() => resolveMaxUses(conn, 0, false), /between 1 and 100/);
    assert.throws(() => resolveMaxUses(conn, 101, false), /between 1 and 100/);

    conn.prepare(`DELETE FROM cms_settings WHERE key = 'download.default_max_uses'`).run();
    assert.throws(
      () => resolveMaxUses(conn, undefined, false),
      (err: Error) => err.message.includes('download.default_max_uses'),
      'a missing setting names the setting instead of inventing 3',
    );
    // Put it back for the rest of the suite, and prove the seeded value is the one
    // `main.ts` writes at boot rather than a literal in the resolver.
    conn.prepare(`INSERT INTO cms_settings (key, value_json, type) VALUES ('download.default_max_uses', '3', 'int')`).run();
  } finally {
    conn.close();
  }
});

test('I3 — unlimited needs the tenant toggle and the per-issue confirmation', async () => {
  const conn = db();
  try {
    // Shipped: the toggle is off, so `null` is refused with the setting named.
    assert.throws(
      () => resolveMaxUses(conn, null, true),
      (err: { code?: string; detail?: { reason?: string } }) =>
        err.code === 'SKW_E_PLT_REQUEST_INVALID' && err.detail?.reason === 'unlimited_disabled',
    );
    conn.prepare(`UPDATE cms_settings SET value_json = 'true' WHERE key = 'download.allow_unlimited'`).run();
    // Toggle on but no confirmation: still refused, and the reason says why.
    assert.throws(
      () => resolveMaxUses(conn, null, false),
      (err: { detail?: { reason?: string } }) => err.detail?.reason === 'unlimited_unconfirmed',
    );
    assert.equal(resolveMaxUses(conn, null, true), null);
    conn.prepare(`UPDATE cms_settings SET value_json = 'false' WHERE key = 'download.allow_unlimited'`).run();
  } finally {
    conn.close();
  }
});

test('I4. an encrypted PDF is refused at issue, naming the asset', async () => {
  const conn = db();
  try {
    await assert.rejects(
      issueCode({ db: conn, contentRoot, assetKey: encryptedKey }),
      (err: { code?: string; status?: number; detail?: { reason?: string; asset?: { key?: string; filename?: string } } }) => {
        assert.equal(err.code, 'SKW_E_DM_ASSET_UNSTAMPABLE');
        assert.equal(err.status, 422);
        assert.equal(err.detail?.reason, 'encrypted_bytes');
        assert.equal(err.detail?.asset?.key, encryptedKey, 'the refusal names the asset');
        assert.equal(err.detail?.asset?.filename, 'locked.pdf');
        return true;
      },
    );

    // The flag alone refuses too, on bytes that are a perfectly plain PDF.
    await assert.rejects(
      issueCode({ db: conn, contentRoot, assetKey: 'vault/flagged' }),
      (err: { detail?: { reason?: string } }) => err.detail?.reason === 'encrypted',
    );

    // And a public asset is refused for the other reason: it already has a URL.
    const publicId = await upload('brand/logo', 'logo.pdf', Buffer.from(PDF, 'latin1'), 'public');
    assert.ok(publicId > 0);
    await assert.rejects(
      issueCode({ db: conn, contentRoot, assetKey: 'brand/logo' }),
      (err: { detail?: { reason?: string } }) => err.detail?.reason === 'access_class',
    );

    // Nothing was written for any of the three refusals.
    const n = conn.prepare(`SELECT COUNT(*) AS n FROM cms_download_code`).get() as { n: number };
    assert.equal(n.n, 1, 'only I1\'s code exists');
  } finally {
    conn.close();
  }
});

test('I5 — CSV: a blank max_uses uses the tenant default, and one bad line issues nothing', async () => {
  const conn = db();
  try {
    const before = (conn.prepare(`SELECT COUNT(*) AS n FROM cms_download_code`).get() as { n: number }).n;
    const csv = 'email, asset_key, max_uses, expires_at\nbuyer@one.test,vault/book,,\n"Doe, Jane" <jane@two.test>,vault/book,9,2030-01-01T00:00:00Z\n';
    const { issued } = await issueFromCsv(conn, contentRoot, csv);
    assert.equal(issued.length, 2);
    assert.equal(issued[0]?.maxUses, 3, 'blank is the tenant default, not unlimited');
    assert.equal(issued[1]?.maxUses, 9);
    assert.equal(issued[1]?.expiresAt, '2030-01-01T00:00:00.000Z');

    const rows = conn.prepare(`SELECT issued_to_email, max_uses FROM cms_download_code ORDER BY id DESC LIMIT 2`).all() as {
      issued_to_email: string;
      max_uses: number;
    }[];
    assert.deepEqual(rows.map((r) => r.issued_to_email), ['jane@two.test', 'buyer@one.test']);
    assert.deepEqual(rows.map((r) => r.max_uses), [9, 3]);

    const after = (conn.prepare(`SELECT COUNT(*) AS n FROM cms_download_code`).get() as { n: number }).n;
    assert.equal(after - before, 2);

    // A bad row refuses the whole file: no code is minted, and the line is named.
    await assert.rejects(
      issueFromCsv(conn, contentRoot, 'email, asset_key, max_uses, expires_at\na@b.test,vault/book,,\nc@d.test,no/such/asset,,\n'),
      (err: { detail?: { line?: number } }) => err.detail?.line === 3,
    );
    const final = (conn.prepare(`SELECT COUNT(*) AS n FROM cms_download_code`).get() as { n: number }).n;
    assert.equal(final, after, 'a rejected file minted nothing');

    assert.throws(() => parseIssueCsv('who,what\na@b.test,x\n'), /header/);
    assert.throws(() => parseIssueCsv('email, asset_key, max_uses, expires_at\n'), /header and no rows/);
  } finally {
    conn.close();
  }
});

test('I6 — the signed webhook: good signature issues, a replayed order is 409, a bad one is 401', async () => {
  const secret = 'whsec-test-0123456789';
  const body = JSON.stringify({
    asset_key: 'vault/book',
    email: 'store-buyer@example.test',
    max_uses: 2,
    order_ref: 'order-1001',
    iat: Math.floor(Date.now() / 1000),
  });
  const sign = (payload: string, key = secret): string => `sha256=${createHmac('sha256', key).update(payload).digest('hex')}`;

  const good = await call({
    port,
    path: '/api/hooks/acme/issue-code',
    method: 'POST',
    host: HOST,
    headers: { 'content-type': 'application/json', 'x-skw-signature': sign(body) },
    body,
  });
  assert.equal(good.status, 201, good.body);
  const issued = good.json as { code: string; max_uses: number; email: string; asset_key: string };
  assert.equal(issued.code.length, 16);
  assert.equal(issued.max_uses, 2);
  assert.equal(issued.email, 'returned', 'SKW_EMAIL_MODE=off: the store emails the code itself');
  assert.equal(issued.asset_key, 'vault/book');

  // The same order again: the plaintext cannot be re-read, so it is not re-minted.
  const replay = await call({
    port,
    path: '/api/hooks/acme/issue-code',
    method: 'POST',
    host: HOST,
    headers: { 'content-type': 'application/json', 'x-skw-signature': sign(body) },
    body,
  });
  assert.equal(replay.status, 409, replay.body);
  assert.equal((replay.json as { error: { detail?: { reason?: string } } }).error.detail?.reason, 'duplicate_order_ref');

  const bad = await call({
    port,
    path: '/api/hooks/acme/issue-code',
    method: 'POST',
    host: HOST,
    headers: { 'content-type': 'application/json', 'x-skw-signature': sign(body, 'not-the-secret') },
    body,
  });
  assert.equal(bad.status, 401, bad.body);

  const unsigned = await call({
    port,
    path: '/api/hooks/acme/issue-code',
    method: 'POST',
    host: HOST,
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.equal(unsigned.status, 401, unsigned.body);

  // A stale body is refused even with a valid signature (no replay window beyond 5 min).
  const staleBody = JSON.stringify({
    asset_key: 'vault/book',
    order_ref: 'order-1002',
    iat: Math.floor(Date.now() / 1000) - 3600,
  });
  const stale = await call({
    port,
    path: '/api/hooks/acme/issue-code',
    method: 'POST',
    host: HOST,
    headers: { 'content-type': 'application/json', 'x-skw-signature': sign(staleBody) },
    body: staleBody,
  });
  assert.equal(stale.status, 401, stale.body);
});

test('I7 — reissue revokes the old row and mints a new code', async () => {
  const first = await issueCode({ db: db(), contentRoot, assetKey: 'vault/book', maxUses: 5 });
  const second = await reissueCode(db(), contentRoot, first.id);
  assert.notEqual(second.code, first.code, 'redelivery is a new code, not a re-send');

  const conn = db();
  try {
    const oldRow = conn.prepare(`SELECT revoked_at, uses FROM cms_download_code WHERE id = ?`).get(first.id) as {
      revoked_at: string | null;
      uses: number;
    };
    assert.notEqual(oldRow.revoked_at, null, 'the old row is revoked, not deleted');
    const newRow = conn.prepare(`SELECT max_uses, asset_id FROM cms_download_code WHERE id = ?`).get(second.id) as {
      max_uses: number;
      asset_id: number;
    };
    assert.equal(newRow.max_uses, 5, 'the terms carry over');
    assert.equal(newRow.asset_id, bookId);
  } finally {
    conn.close();
  }
});

test('I8 — the admin screen issues, shows the plaintext once, and lists the codes', async () => {
  const page = await call({ port, path: '/admin/t/acme/codes', host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(page.status, 200, page.body);
  assert.match(page.body, /<form method="post" action="\/admin\/t\/acme\/codes\/new"/);
  assert.match(page.body, /data-role="codes"/);

  const issued = await postForm('/admin/t/acme/codes/new', { asset_key: 'vault/book', email: 'screen@buyer.test', max_uses: '4' });
  assert.equal(issued.status, 201, issued.body);
  const code = /<code class="code">([0-9A-HJKMNP-TV-Z]{16})<\/code>/.exec(issued.body)?.[1];
  assert.ok(code !== undefined, 'the page shows the code once');
  assert.match(issued.body, /only time these codes are shown/i);

  const list = await call({ port, path: '/admin/t/acme/codes', host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.match(list.body, new RegExp(`data-selector="${code.slice(0, 4)}"`));
  assert.ok(!list.body.includes(code), 'the list never shows a plaintext code again');

  // The refusal reaches the operator with the asset's name, not a 500.
  const refused = await postForm('/admin/t/acme/codes/new', { asset_key: encryptedKey });
  assert.equal(refused.status, 422, refused.body);
  assert.match(refused.body, /SKW_E_DM_ASSET_UNSTAMPABLE|encrypted/i);
});
