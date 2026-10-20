/**
 * S2e (4) — O-29's preview token: `GET <path>?preview=<token>`, 30 minutes,
 * accepted only for `status='draft'`, `Cache-Control: no-store`, logged once per
 * render. The token is `HMAC(SKW_SESSION_KEY, tenant|path|exp)`.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { after, before, test } from 'node:test';

import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { PREVIEW_TTL_MS, loadPageForRender, mintPreviewToken } from '../app/render/preview.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { call } from './helpers/http.ts';

const SESSION_KEY = 'test-session-key-0123456789abcdef';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;

before(async () => {
  fixture = makeFixture({
    specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme', body: '<h1>published</h1>' }],
  });
  const db = new Database(fixture.sitePath('acme'));
  try {
    db.prepare(
      `INSERT INTO cms_page (path, slug, title, status, template, body_html)
       VALUES ('/draft-page', 'draft-page', 'Draft page', 'draft', 'page', '<h1>draft only</h1>')`,
    ).run();
  } finally {
    db.close();
  }
  handle = await buildApp({ env: loadEnv(fixture.env) });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

function get(path: string): ReturnType<typeof call> {
  return call({ port, path, host: 'acme.test' });
}

test('S2E-11. a preview token for a draft page renders it, with no-store', async () => {
  const token = mintPreviewToken('acme', '/draft-page', SESSION_KEY, Date.now());
  const res = await get(`/draft-page?preview=${token}`);
  assert.equal(res.status, 200, `expected the draft to render, got ${res.status}: ${res.body}`);
  assert.match(res.body, /draft only/);
  assert.equal((res.headers['cache-control'] ?? '') as string, 'no-store');
});

test('S2E-12. the same token is rejected for a published page', async () => {
  const token = mintPreviewToken('acme', '/pricing', SESSION_KEY, Date.now());
  const res = await get(`/pricing?preview=${token}`);
  assert.equal(res.status, 404, 'a preview token may only widen the draft path');
  assert.equal((res.json as { error?: { code?: string } }).error?.code, 'SKW_E_RT_PAGE_NOT_FOUND');
});

test('S2E-13. a token older than 30 minutes is rejected; a token minted for another path is rejected', async () => {
  const expired = mintPreviewToken('acme', '/draft-page', SESSION_KEY, Date.now() - PREVIEW_TTL_MS - 1_000);
  const a = await get(`/draft-page?preview=${expired}`);
  assert.equal(a.status, 404, 'an expired preview token must not render a draft');

  const otherPath = mintPreviewToken('acme', '/somewhere-else', SESSION_KEY, Date.now());
  const b = await get(`/draft-page?preview=${otherPath}`);
  assert.equal(b.status, 404, 'a token is bound to one tenant and one path');

  const tampered = `${mintPreviewToken('acme', '/draft-page', SESSION_KEY, Date.now())}00`;
  const c = await get(`/draft-page?preview=${tampered}`);
  assert.equal(c.status, 404, 'a token with a changed MAC must not render');

  const noToken = await get('/draft-page');
  assert.equal(noToken.status, 404, 'without a token a draft is invisible');
});

test('S2E-14. the TTL is exactly 30 minutes, and a token is logged exactly once per accepted render', () => {
  const now = 1_790_000_000_000;
  const token = mintPreviewToken('acme', '/draft-page', SESSION_KEY, now);
  const exp = Number(token.split('.')[0]);
  assert.equal(exp, Math.floor(now / 1000) + PREVIEW_TTL_MS / 1000);
  assert.equal(PREVIEW_TTL_MS, 30 * 60 * 1000);

  const db = new Database(fixture.sitePath('acme'), { readonly: true });
  try {
    const lines: string[] = [];
    const first = loadPageForRender(db, {
      tenantKey: 'acme',
      path: '/draft-page',
      token,
      sessionKey: SESSION_KEY,
      nowMs: now,
      log: (line: string) => lines.push(line),
    });
    assert.equal(first.preview, true);
    assert.equal(lines.length, 1, `a preview render logs one line; got ${JSON.stringify(lines)}`);
    assert.match(lines[0] as string, /preview/);
    assert.match(lines[0] as string, /acme/);
    assert.match(lines[0] as string, /\/draft-page/);

    const rejected = loadPageForRender(db, {
      tenantKey: 'acme',
      path: '/draft-page',
      token: mintPreviewToken('acme', '/draft-page', SESSION_KEY, now - PREVIEW_TTL_MS - 1),
      sessionKey: SESSION_KEY,
      nowMs: now,
      log: (line: string) => lines.push(line),
    }).page;
    assert.equal(rejected, null, 'an expired token must fall back to the published lookup and miss');
    assert.equal(lines.length, 1, 'a refused preview must not be logged as a render');
  } finally {
    db.close();
  }
});
