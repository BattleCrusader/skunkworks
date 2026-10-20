/**
 * S5 item 1 — **the ten host call sites of the twelve hooks** (§13.3.4).
 *
 * The dispatch primitive was already tested (`plugin-load.test.ts` L5–L7); what these cases
 * prove is the thing a spec cannot prove by existing: that each hook is **called** at a real
 * call site, with the arguments the table names, and that its return value **changes** the
 * value the host was about to use. A hook that is registered and never dispatched is a lie in
 * the spec, and a hook that is dispatched with the wrong arguments is a lie with better
 * paperwork.
 *
 * The fixture (`test/fixtures/plugins/hooksall`) declares all twelve hooks, appends a JSONL
 * trace line per dispatch (arguments, observed), and returns a value that is visibly different
 * from the one it was handed. `hooksall`'s trace file is the only channel; nothing in `app/`
 * reads it.
 *
 *   H1  `page.head`         the markup is in the served `<head>`, and the call carried `path`
 *   H2  `content.render.html` the body is replaced, and only the body
 *   H3  `asset.url`         the emitted `src` is the filter's URL; the call carried the key
 *   H4  `form.validate`     a plugin may refuse what core accepted → 422, no row
 *   H5  `form.submitted`    the action fires after the commit, with the row's id
 *   H6  `admin.menu`        a declared screen is added; an undeclared href is dropped
 *   H7  `mail.template`     the returned vars are what the host measured (32 KiB refusal)
 *   H8  `download.redeemed` the action fires on a real redemption, with codeId/assetKey/jti
 *   H9  `admin.login`       the action fires after authentication, with the operator id
 *   H10 `page.rendered`     the action fires with `{path, status, ms}` and its return is ignored
 *   H11 `plugin.enabled` / `plugin.disabled` — the two lifecycle actions, both call sites
 *   H12 no plugin attached: every call site passes its value through and counts nothing
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { installPlugin } from '../app/plugins/install.ts';
import { packageRootHash } from '../app/plugins/manifest.ts';
import { attachPluginRuntime } from '../app/plugins/site.ts';
import { uploadAsset } from '../app/assets/library.ts';
import { issueCode } from '../app/download/code.ts';
import { openAdminWrite } from '../app/db/classes.ts';
import { formIntentToken } from '../app/forms/intake.ts';
import { ADMIN_HOST, PASSWORD, TOTP_SECRET, openSession, seedUser } from './helpers/admin.ts';
import { REPO, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, type Res } from './helpers/http.ts';

const TENANT = 'acme';
const HOST = 'acme.test';
const DIGEST = 'sha256:s5-hooks-app';
const HOOKSALL = join(REPO, 'test', 'fixtures', 'plugins', 'hooksall');
/** A real PNG, encoded by the same libvips the upload gate decodes with. */
let pixel: Buffer = Buffer.alloc(0);

interface TraceLine {
  hook: string;
  call: Record<string, unknown>;
  value: unknown;
}

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let tracePath = '';
let contentRoot = '';

function siteDbFile(): string {
  return fixture.sitePath(TENANT);
}

/** The install gate wants a report whose `root_hash` is the package on disk. */
function report(sourceDir: string, plugin: string): string {
  const { root } = packageRootHash(sourceDir);
  const path = join(fixture.dir, `${plugin}-report.json`);
  writeFileSync(
    path,
    `${JSON.stringify({ plugin, version: '1.0.0', root_hash: root, runner_image_digest: DIGEST, ran_at: new Date().toISOString() }, null, 2)}\n`,
  );
  return path;
}

function install(sourceDir: string, plugin: string): void {
  installPlugin({
    siteDb: siteDbFile(),
    pluginsRoot: join(fixture.dir, 'plugins'),
    sourceDir,
    allowUnsigned: true,
    testReportPath: report(sourceDir, plugin),
    runnerImageDigest: DIGEST,
  });
}

function trace(): TraceLine[] {
  let raw = '';
  try {
    raw = readFileSync(tracePath, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as TraceLine);
}

function traces(hook: string): TraceLine[] {
  return trace().filter((line) => line.hook === hook);
}

function resetTrace(): void {
  rmSync(tracePath, { force: true });
}

function get(path: string, headers: Record<string, string> = {}): Promise<Res> {
  return call({ port, path, host: HOST, headers });
}

function postForm(path: string, fields: Record<string, string>): Promise<Res> {
  return call({
    port,
    path,
    method: 'POST',
    host: HOST,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: TENANT, hosts: [HOST], title: 'Acme', body: '<h1>Hook page</h1>' }] });
  tracePath = join(fixture.dir, 'hook-trace.jsonl');
  process.env.SKW_HOOK_TRACE = tracePath;
  // `mail.send` is a named refusal when email is off (§4.3). This gate needs the *path* to run
  // to see what the filter returned reach the host's 32 KiB check, so the box is configured
  // the one way that answers it. No mailer exists in v1; `queued: true` is the whole response.
  fixture.env.SKW_EMAIL_MODE = 'smtp';
  fixture.env.SKW_SMTP_URL = 'smtp://127.0.0.1:2525';
  contentRoot = join(fixture.dir, 'content');
  pixel = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0.5 } } })
    .png()
    .toBuffer();

  install(HOOKSALL, 'hooksall');

  const db = openAdminWrite(siteDbFile(), 5000);
  try {
    db.prepare(
      `INSERT INTO cms_page (path, slug, title, status, template, body_html)
       VALUES ('/hook-page', 'hook-page', 'Hook page', 'published', 'page', '<h1>Hook page</h1><img data-asset-key="work/one" alt="">')`,
    ).run();
    db.prepare(
      `INSERT INTO cms_form (key, title, fields_json, mode)
       VALUES ('contact', 'Contact', ?, 'store')`,
    ).run(JSON.stringify([{ name: 'email', required: true }, { name: 'message', required: true, max: 200 }]));
  } finally {
    db.close();
  }

  // A public asset for `asset.url`, and a gated one for `download.redeemed`.
  const upload = async (key: string, accessClass: 'public' | 'gated'): Promise<void> => {
    const conn = openAdminWrite(siteDbFile(), 5000);
    try {
      await uploadAsset({
        db: conn,
        contentRoot,
        tenantKey: TENANT,
        key,
        filename: `${key.replace('/', '-')}.png`,
        // A real PNG: the upload gate sniffs and decodes through libvips, and a hand-rolled
        // header is refused `SKW_E_SEC_UPLOAD_REJECTED` before any row exists.
        bytes: pixel,
        quotaLimitBytes: 10_000_000,
        accessClass,
      });
    } finally {
      conn.close();
    }
  };
  await upload('work/one', 'public');
  await upload('vault/book', 'gated');

  handle = await buildApp({ env: loadEnv(fixture.env) });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
  // Install leaves the row `enabled = 0`; the operator's enable is the step that imports.
  await handle.plugins.enable(TENANT, 'hooksall');
  resetTrace();
});

after(async () => {
  delete process.env.SKW_HOOK_TRACE;
  await handle.close();
  fixture.cleanup();
});

test('H1. page.head — the returned markup is in the served <head>, and the call carried the path', async () => {
  const res = await get('/hook-page');
  assert.equal(res.status, 200);
  assert.match(res.body, /<meta name="hooksall" content="page.head">/);
  const [line] = traces('page.head');
  assert.ok(line !== undefined, 'page.head was never dispatched');
  assert.equal(line.call.tenant, TENANT);
  assert.equal(line.call.path, '/hook-page');
});

test('H2. content.render.html — the body is replaced and the status/route are not', async () => {
  const res = await get('/hook-page');
  assert.equal(res.status, 200);
  assert.match(res.body, /<p data-hook="content">content\.render\.html<\/p>/);
  assert.match(res.body, /Hook page<\/h1>/, 'the original body must survive inside the returned html');
  const [line] = traces('content.render.html');
  assert.ok(line !== undefined);
  assert.equal(line.call.tenant, TENANT);
  assert.equal((line.call.page as { title?: string }).title, 'Hook page');
});

test('H3. asset.url — the emitted src is the filter\'s URL; the call carried the key and the original', async () => {
  const res = await get('/hook-page');
  assert.equal(res.status, 200);
  assert.match(res.body, /src="\/media\/cdn\/work\/one\.[a-z]+/);
  const [line] = traces('asset.url');
  assert.ok(line !== undefined, 'asset.url was never dispatched');
  assert.equal(line.call.key, 'work/one');
  assert.match(String(line.call.url), /^\/media\/work\/one\./);
});

test('H4. form.validate — a plugin may refuse what core accepted: 422, no row', async () => {
  const token = formIntentToken(TENANT, 'contact', handle.env.sessionKey, Date.now() - 2000);
  const res = await postForm('/f/contact', { email: 'blocked@example.com', message: 'hello', _pt: token });
  assert.equal(res.status, 422, res.body);
  const body = res.json as { ok: boolean; errors: { field: string; message: string }[] };
  assert.equal(body.ok, false);
  assert.equal(body.errors[0]?.field, 'email');
  const db = new Database(siteDbFile(), { readonly: true });
  try {
    assert.equal(Number((db.prepare('SELECT count(*) AS n FROM cms_form_submission').get() as { n: number }).n), 0);
  } finally {
    db.close();
  }
  const [line] = traces('form.validate');
  assert.ok(line !== undefined, 'form.validate was never dispatched');
  assert.equal(line.call.form, 'contact');
  assert.equal((line.call.values as { email?: string }).email, 'blocked@example.com');
});

test('H5. form.submitted — after the commit, with the id the row got', async () => {
  const token = formIntentToken(TENANT, 'contact', handle.env.sessionKey, Date.now() - 2000);
  const res = await postForm('/f/contact', { email: 'buyer@example.com', message: 'hello', _pt: token });
  assert.equal(res.status, 202, res.body);
  const id = (res.json as { id: number }).id;
  assert.ok(id > 0);
  const db = new Database(siteDbFile(), { readonly: true });
  try {
    const row = db.prepare('SELECT form_id, payload_json FROM cms_form_submission WHERE id = ?').get(id) as
      | { form_id: number; payload_json: string }
      | undefined;
    assert.ok(row !== undefined, 'the submission row must exist before the action fires');
    assert.match(row.payload_json, /buyer@example\.com/);
    assert.doesNotMatch(row.payload_json, /_pt/, 'the intent token is not submission content');
  } finally {
    db.close();
  }
  const [line] = traces('form.submitted');
  assert.ok(line !== undefined, 'form.submitted was never dispatched');
  assert.equal(line.call.form, 'contact');
  assert.equal(line.call.submissionId, id);
});

test('H6. admin.menu — a declared screen is added and an undeclared href is dropped', async () => {
  const email = 'owner@acme.test';
  await seedUser({ controlDb: fixture.controlDb, tenantKey: TENANT, email, totpSecret: TOTP_SECRET });
  const session = await openSession({ port, key: TENANT, email, password: PASSWORD });
  const res = await call({ port, path: `/admin/t/${TENANT}/`, host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, new RegExp(`href="/admin/t/${TENANT}/hooks-screen">Hook messages`));
  assert.doesNotMatch(res.body, /not-a-screen/, 'an entry outside a declared screen must be dropped');
  assert.match(res.body, new RegExp(`href="/admin/t/${TENANT}/pages">Pages`), 'core entries survive the filter');
  const [line] = traces('admin.menu');
  assert.ok(line !== undefined, 'admin.menu was never dispatched');
  assert.equal(line.call.tenant, TENANT);
  const items = line.call.items as { href: string }[];
  assert.ok(items.some((i) => i.href === `/admin/t/${TENANT}/pages`), 'the filter is handed core\'s items');
});

test('H7. mail.template — the returned vars are what the host measured', async () => {
  const db = openAdminWrite(siteDbFile(), 5000);
  try {
    const ctx = handle.plugins.makeContext(TENANT, 'hooksall', 'endpoint', db);
    const queued = (await ctx.facade['mail.send']({
      to: 'buyer@example.com',
      template: 'receipt',
      vars: { total: '10.00' },
    })) as { queued: boolean; to: string; template: string };
    assert.equal(queued.queued, true);
    assert.equal(queued.template, 'receipt');
    // The effect: the fixture pads the object it returns when it sees `pad: 'yes'`, and the
    // host's own 32 KiB measure is what refuses it. If the host had ignored the return value,
    // this call would have been queued like the one above.
    await assert.rejects(
      async () =>
        ctx.facade['mail.send']({ to: 'buyer@example.com', template: 'receipt', vars: { total: '10.00', pad: 'yes' } }),
      (err: Error) => /SKW_E_PL_MAIL: vars exceed 32 KiB/.test(err.message),
    );
    ctx.close();
  } finally {
    db.close();
  }
  const lines = traces('mail.template');
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.call.template, 'receipt');
  assert.equal((lines[0]?.call.vars as { total?: string }).total, '10.00');
});

test('H8. download.redeemed — a real redemption fires the action with codeId, assetKey and jti', async () => {
  const db = openAdminWrite(siteDbFile(), 5000);
  let code = '';
  let codeId = 0;
  try {
    const issued = await issueCode({ db, contentRoot, assetKey: 'vault/book', maxUses: 3, confirmUnlimited: false });
    code = issued.code;
    codeId = issued.id;
  } finally {
    db.close();
  }
  resetTrace();
  const res = await call({
    port,
    path: `/d/${TENANT}`,
    method: 'POST',
    host: HOST,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  assert.equal(res.status, 303, res.body);
  const [line] = traces('download.redeemed');
  assert.ok(line !== undefined, 'download.redeemed was never dispatched');
  assert.equal(line.call.tenant, TENANT);
  assert.equal(line.call.codeId, codeId);
  assert.equal(line.call.assetKey, 'vault/book');
  assert.match(String(line.call.jti), /^[0-9a-f]{32}$/);
});

test('H9. admin.login — post-authentication, with the operator id', async () => {
  const email = 'second@acme.test';
  const userId = await seedUser({ controlDb: fixture.controlDb, tenantKey: TENANT, email, totpSecret: TOTP_SECRET });
  resetTrace();
  const session = await openSession({ port, key: TENANT, email, password: PASSWORD });
  assert.ok(session.cookie.startsWith('__Host-sk-sess'));
  const [line] = traces('admin.login');
  assert.ok(line !== undefined, 'admin.login was never dispatched');
  assert.equal(line.call.tenant, TENANT);
  assert.equal(line.call.operatorId, userId);
});

test('H10. page.rendered — an action: `{path, status, ms}`, and its return value is ignored', async () => {
  resetTrace();
  const res = await get('/hook-page');
  assert.equal(res.status, 200);
  const [line] = traces('page.rendered');
  assert.ok(line !== undefined, 'page.rendered was never dispatched');
  assert.equal(line.call.tenant, TENANT);
  assert.equal(line.call.path, '/hook-page');
  assert.equal(line.call.status, 200);
  assert.equal(typeof line.call.ms, 'number');
  // The fixture returns the string 'IGNORED-BY-CONTRACT'. An action that used a return value
  // would have written it into the page; nothing in the body is that string.
  assert.doesNotMatch(res.body, /IGNORED-BY-CONTRACT/);
});

test('H11. plugin.enabled and plugin.disabled — both lifecycle actions fire at their call sites', async () => {
  resetTrace();
  await handle.plugins.disable(TENANT, 'hooksall');
  await handle.plugins.enable(TENANT, 'hooksall');
  const enabled = traces('plugin.enabled');
  const disabled = traces('plugin.disabled');
  assert.equal(disabled.length, 1, 'plugin.disabled must fire on disable, before the prune');
  assert.equal(enabled.length, 1, 'plugin.enabled must fire after the commit');
  assert.equal(enabled[0]?.call.tenant, TENANT);
  assert.equal(disabled[0]?.call.tenant, TENANT);
  assert.equal(disabled[0]?.call.plugin, 'hooksall');
});

test('H12. no runtime attached — every call site passes its value through and counts nothing', async () => {
  attachPluginRuntime(null);
  try {
    const res = await get('/hook-page');
    assert.equal(res.status, 200, 'a page must render with no plugin runtime attached');
    assert.doesNotMatch(res.body, /data-hook="content"/);
    assert.doesNotMatch(res.body, /hooksall/);
    assert.match(res.body, /src="\/media\/work\/one\./, 'the row\'s own URL, not the filter\'s');
  } finally {
    attachPluginRuntime(handle.plugins);
  }
});
