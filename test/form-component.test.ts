/**
 * The `form` component, from the registry to a stored submission.
 *
 * `schema/component-registry.json` declares `components/form.ts` and that file never existed, so
 * the `form` block the editor's palette offers produced markup that posted to the page's own URL
 * with no `_pt`, and `submitCoreForm` refused it (`missing`). Nothing in the suite could catch that,
 * because every existing form gate (`plugin-hooks-wired.test.ts` H4/H5) mints the token itself:
 * they prove the *intake* works, not that anything a page emits can satisfy it.
 *
 * This file is the missing link, in the order the product does it:
 *
 *   G1  the block the palette inserts comes from the registry (`loadRegistry()`), not from a
 *       string in this test — a hardcoded fixture would stay green after the registry changed —
 *       and the renderer file the entry names exists.
 *   G2  that body, stored on a page and served, contains a form that posts to `/f/<key>` with a
 *       `_pt` whose signature verifies for **this** tenant and **this** form key, an empty `_hp`,
 *       and an input for every field `fields_json` declares (the registry's markup only authors
 *       `email`; `message` is added from the row).
 *   G3  submitting the page's own fields and the page's own token through `POST /f/<key>` stores
 *       a row — the token is not merely well-formed, it is accepted.
 *   G4  negative controls, so G3 cannot pass for the wrong reason: no `_pt` is refused, a token
 *       presented to a *different* form key is refused, and a filled `_hp` is a 202 with no row.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';

import Database from 'better-sqlite3';

import { openAdminWrite } from '../app/db/classes.ts';
import { loadRegistry } from '../app/editor/registry.ts';
import { loadEnv } from '../app/env.ts';
import { verifyFormIntent } from '../app/forms/intake.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { REPO, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, type Res } from './helpers/http.ts';

const TENANT = 'acme';
const HOST = 'acme.test';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let pageHtml = '';

function siteDb(): string {
  return fixture.sitePath(TENANT);
}

after(async () => {
  if (handle !== undefined) await handle.close();
  if (fixture !== undefined) fixture.cleanup();
});

/** One input's `value` out of the served page, by `name`. */
function field(html: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag = new RegExp(`<input[^>]*name="${escaped}"[^>]*>`).exec(html)?.[0];
  if (tag === undefined) return undefined;
  return /value="([^"]*)"/.exec(tag)?.[1] ?? '';
}

async function postForm(path: string, fields: Record<string, string>): Promise<Res> {
  return call({
    port,
    path,
    host: HOST,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

async function countRows(): Promise<number> {
  const db = new Database(siteDb(), { readonly: true });
  try {
    return Number((db.prepare('SELECT count(*) AS n FROM cms_form_submission').get() as { n: number }).n);
  } finally {
    db.close();
  }
}

/** The instant the page's token was minted, so a gate can wait out the 1.5 s minimum fill. */
function mintedAtMs(token: string): number {
  return Number(token.slice(0, token.indexOf('.'))) * 1000;
}

test('G1 — the `form` block comes from the registry, and its renderer exists', () => {
  const entry = loadRegistry(`${REPO}/schema`).byName.get('form');
  assert.ok(entry !== undefined, 'the registry has no `form` component');
  assert.equal(entry.renderer, 'components/form.ts');
  assert.ok(entry.html !== null, 'the `form` entry has no block markup');
  assert.match(entry.html, /data-gjs-type="form"/);
  assert.match(entry.html, /data-form="contact"/);
  // The renderer the registry names is a file, not a promise. This is the assertion that would
  // have failed for the whole life of the registry until now.
  assert.ok(
    existsSync(`${REPO}/app/render/components/form.ts`),
    'the registry declares components/form.ts and that file does not exist',
  );
});

test('G2 — a page built from the registry block renders a submittable form', async () => {
  fixture = makeFixture({ specs: [{ key: TENANT, hosts: [HOST], title: 'Acme' }] });
  const entry = loadRegistry(`${REPO}/schema`).byName.get('form');
  assert.ok(entry !== undefined && entry.html !== null);

  const db = openAdminWrite(siteDb(), 5000);
  try {
    db.prepare(
      `INSERT INTO cms_page (path, slug, title, status, template, body_html)
       VALUES ('/contact', 'contact', 'Contact', 'published', 'page', ?)`,
    ).run(`<h1>Contact</h1>${entry.html}`);
    db.prepare(
      `INSERT INTO cms_form (key, title, fields_json, mode)
       VALUES ('contact', 'Contact', ?, 'store')`,
    ).run(JSON.stringify([{ name: 'email', required: true, type: 'email' }, { name: 'message', required: true, max: 200 }]));
    // A second form: the cross-key negative control in G4 needs a key that is real but not this one.
    db.prepare(
      `INSERT INTO cms_form (key, title, fields_json, mode)
       VALUES ('newsletter', 'Newsletter', ?, 'store')`,
    ).run(JSON.stringify([{ name: 'email', required: true }]));
  } finally {
    db.close();
  }

  handle = await buildApp({ env: loadEnv(fixture.env) });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  port = (handle.app.server.address() as AddressInfo).port;

  const res = await call({ port, path: '/contact', host: HOST });
  assert.equal(res.status, 200, res.body.slice(0, 400));
  pageHtml = res.body;

  // The action and the method: a form that posts to its own page is the bug this component removes.
  const formTag = /<form[^>]*>/.exec(pageHtml)?.[0] ?? '';
  assert.match(formTag, /action="\/f\/contact"/);
  assert.match(formTag, /method="post"/);
  assert.match(formTag, /data-form-intent="minted"/);

  // The token: present, and **verifying** for (acme, contact) against the app's own secret.
  const token = field(pageHtml, '_pt');
  assert.ok(token !== undefined && token !== '', `the served form carries no _pt (${formTag})`);
  const minted = mintedAtMs(String(token));
  // Verify at its own timestamp + 2 s: the served instant is "now", so this asserts the signature
  // rather than the age (G3 waits the age out for real).
  assert.deepEqual(
    verifyFormIntent(TENANT, 'contact', String(token), handle.env.sessionKey, minted + 2000),
    { ok: true },
    'the token the page emitted does not verify for (acme, contact)',
  );
  // …and it is this form's token, not any form's.
  assert.deepEqual(
    verifyFormIntent(TENANT, 'newsletter', String(token), handle.env.sessionKey, minted + 2000),
    { ok: false, reason: 'signature' },
    'the token is not bound to the form key',
  );

  // The honeypot: present, empty, and out of a person's way.
  assert.equal(field(pageHtml, '_hp'), '', 'the honeypot is missing or pre-filled');
  assert.match(pageHtml, /data-honeypot/, 'the honeypot has no marker for the gate to find');

  // The field list came from `fields_json`: `email` is the registry's markup, `message` is not.
  assert.ok(
    !/name="message"/.test(entry.html),
    'the registry markup already authors `message`, so this control proves nothing',
  );
  assert.notEqual(field(pageHtml, 'email'), undefined, 'the authored email input was lost');
  const messageTag = /<input[^>]*name="message"[^>]*>/.exec(pageHtml)?.[0];
  assert.ok(messageTag !== undefined, 'no input was rendered for the declared field `message`');
  assert.match(String(messageTag), /required/, 'a required field rendered without `required`');
  assert.match(String(messageTag), /maxlength="200"/, 'the field cap from fields_json was dropped');
});

test('G3 — the page’s own form submits: POST /f/<key> stores a row', async () => {
  const token = String(field(pageHtml, '_pt') ?? '');
  assert.ok(token !== '');
  // O-30's minimum fill is 1.5 s: a submission faster than a human can type is not one.
  const wait = mintedAtMs(token) + 1700 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  const res = await postForm('/f/contact', { _pt: token, email: 'buyer@example.com', message: 'hello from the page' });
  assert.equal(res.status, 202, res.body);
  const body = res.json as { ok: boolean; id: number };
  assert.equal(body.ok, true);
  assert.ok(body.id > 0);

  const db = new Database(siteDb(), { readonly: true });
  try {
    const row = db.prepare('SELECT payload_json FROM cms_form_submission WHERE id = ?').get(body.id) as
      | { payload_json: string }
      | undefined;
    assert.ok(row !== undefined, 'the submission the page made has no row');
    assert.match(row.payload_json, /buyer@example\.com/);
    assert.match(row.payload_json, /hello from the page/);
    // The token is a nonce, not content: it is consumed, never stored.
    assert.doesNotMatch(row.payload_json, /_pt/);
  } finally {
    db.close();
  }
});

test('G4 — negative controls: no token, another form’s key, and a filled honeypot', async () => {
  const token = String(field(pageHtml, '_pt') ?? '');
  assert.ok(token !== '');
  const wait = mintedAtMs(token) + 1700 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  // 1. No `_pt` at all: the state every page was in before this component existed.
  const missing = await postForm('/f/contact', { email: 'no-token@example.com', message: 'x' });
  assert.equal(missing.status, 400, `a post with no _pt was ${missing.status}, not 400`);
  assert.match(missing.body, /token is missing/i);

  // 2. The same token, presented to a different form key. The HMAC covers `tenant|form|ts`, so
  //    this is the assertion that the token is bound to the form and not just to the tenant.
  const crossKey = await postForm('/f/newsletter', { _pt: token, email: 'cross@example.com' });
  assert.equal(crossKey.status, 400, `a token for another form was ${crossKey.status}, not 400`);
  assert.match(crossKey.body, /token is signature/i);

  // 3. The honeypot: a filled `_hp` is answered 202 with the success body and **no row**. Without
  //    this control a renderer could emit `_hp` with the token in it and every other assertion
  //    above would still pass.
  const before = await countRows();
  const bot = await postForm('/f/contact', { _pt: token, _hp: 'i am a robot', email: 'bot@example.com', message: 'x' });
  assert.equal(bot.status, 202, bot.body);
  assert.equal(await countRows(), before, 'a honeypot submission wrote a row');
});
