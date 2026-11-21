/**
 * The surface where an operator actually answers a package: **Package settings** on the Plugins
 * screen (v12).
 *
 * Before this file existed the capability was asserted and unusable. `contact` declared
 * `notify_email`, `settings.get` was wired through the facade, and there was no screen, no CLI verb
 * and no form anywhere that could write the row — so the digest's first question ("who is told?")
 * could only be answered by opening SQLite. A setting an operator cannot set is not a setting.
 *
 * What is checked here, over a socket, against the real app and the real tenant file:
 *
 *   S1  the screen draws one fieldset per installed package from `manifest.settings` alone, asks each
 *       question with the **control its type names** (a clock for `time`, a choice for `select`, an
 *       address field for `email`), prefills an unset `defaultFrom: "operator-email"` setting with
 *       the logged-in operator's address — and never prints a storage bound as help text
 *   S2  a save writes the declared keys, redirects, and audits the **keys** and no values
 *   S3  a value the host refuses comes back on the screen with its code, and nothing is written
 *   S4  a field the manifest does not declare is not a setting: it is dropped, not written
 *   S5  the same save without the CSRF token is refused, and writes nothing
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { totpCode } from '../app/admin/auth.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { installPlugin } from '../app/plugins/install.ts';
import { packageRootHash } from '../app/plugins/manifest.ts';
import {
  ADMIN_HOST,
  ADMIN_ORIGIN,
  TOTP_SECRET,
  login,
  seedUser,
  type Sessioned,
} from './helpers/admin.ts';
import { REPO, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, header, type Res } from './helpers/http.ts';

const TENANT = 'acme';
const OPERATOR = 'owner@acme.test';
const CONTACT = join(REPO, 'plugins', 'contact');

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let session: Sessioned;

async function postForm(path: string, fields: Record<string, string>, opts: { csrf?: boolean } = {}): Promise<Res> {
  const headers: Record<string, string> = {
    cookie: session.cookie,
    origin: ADMIN_ORIGIN,
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (opts.csrf !== false) headers['x-csrf-token'] = session.csrfToken;
  return call({ port, path, method: 'POST', host: ADMIN_HOST, headers, body: new URLSearchParams(fields).toString() });
}

function settingsRows(): { key: string; value_json: string }[] {
  const db = new Database(fixture.sitePath(TENANT), { readonly: true });
  try {
    return db
      .prepare("SELECT key, value_json FROM cms_plugin_setting WHERE plugin_id = 'contact' ORDER BY key")
      .all() as { key: string; value_json: string }[];
  } finally {
    db.close();
  }
}

/** The tenant's own settings: the clock lives here, not in the package's table. */
function siteSettings(): { key: string; value_json: string }[] {
  const db = new Database(fixture.sitePath(TENANT), { readonly: true });
  try {
    return db
      .prepare("SELECT key, value_json FROM cms_settings WHERE key = 'timezone' ORDER BY key")
      .all() as { key: string; value_json: string }[];
  } finally {
    db.close();
  }
}

function auditActions(): string[] {
  const db = new Database(fixture.controlDb, { readonly: true });
  try {
    return (db.prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[]).map((row) => row.action);
  } finally {
    db.close();
  }
}

before(async () => {
  fixture = makeFixture();
  await seedUser({ controlDb: fixture.controlDb, tenantKey: TENANT, email: OPERATOR, totpSecret: TOTP_SECRET });

  // A real install, with the report the packager would have written: the settings screen reads the
  // manifest this tenant installed, so nothing here can be exercised without one.
  const { root } = packageRootHash(CONTACT);
  const report = join(fixture.dir, 'contact-report.json');
  writeFileSync(
    report,
    `${JSON.stringify({ plugin: 'contact', version: '2.0.0', root_hash: root, runner_image_digest: 'sha256:settings-gate', ran_at: new Date().toISOString() }, null, 2)}\n`,
  );
  installPlugin({
    siteDb: fixture.sitePath(TENANT),
    pluginsRoot: join(fixture.dir, 'plugins'),
    sourceDir: CONTACT,
    allowUnsigned: true,
    testReportPath: report,
    runnerImageDigest: 'sha256:settings-gate',
  });

  handle = await buildApp({
    env: loadEnv({ ...fixture.env, SKW_EMAIL_MODE: 'smtp', SKW_SMTP_URL: 'smtp://relay.invalid:587', SKW_MAIL_FROM: 'noreply@acme.test' }),
  });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;

  const res = await login({ port, key: TENANT, email: OPERATOR, totp: totpCode(TOTP_SECRET, Date.now()) });
  assert.equal(res.status, 200, res.body);
  const raw = String(header(res, 'set-cookie'));
  const json = res.json as { csrfToken: string };
  session = { cookie: raw.slice(0, raw.indexOf(';')), csrfToken: json.csrfToken, email: OPERATOR };
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

test('S1. the screen draws the declared settings and prefills the operator’s own address', async () => {
  const res = await call({ port, path: `/admin/t/${TENANT}/plugins`, host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /Package settings/);
  // One fieldset per installed package, named by the package, not by the host.
  assert.match(res.body, /data-settings-for="contact"/);
  // The settings the package declares — and no cursor, because the cursor lives in its table.
  assert.match(res.body, /name="s_notify_email"/);
  assert.match(res.body, /name="s_digest_cadence"/);
  assert.match(res.body, /name="s_digest_at"/);
  assert.doesNotMatch(res.body, /name="s_digest_last_id"/);

  // The control comes from the declaration: a clock, a choice, an address field.
  assert.match(res.body, /<input type="time" id="s_contact_digest_at"/);
  assert.match(res.body, /<select id="s_contact_digest_cadence"/);
  assert.match(res.body, /<option value="Every weekday"[^>]*>Every weekday</);
  assert.match(res.body, /<option value="Off"[^>]*>Off</);
  assert.match(res.body, /<input type="email" id="s_contact_notify_email"/);
  // The label is the package's sentence, not its key.
  assert.match(res.body, /Send me the enquiry digest/);
  assert.doesNotMatch(res.body, /digest_cadence</, 'the key was printed at a person');
  // A storage bound is an attribute, never an instruction.
  assert.doesNotMatch(res.body, /Up to \d+ characters/);
  assert.match(res.body, /maxlength="254"/);
  // The zone is asked for with the time, because a time without one is a time in a zone nobody chose.
  assert.match(res.body, /<select id="tz" name="timezone"/);
  assert.match(res.body, /Times are in/);

  // The layout is the markup's job, not the legacy form grid's: the form names itself, and each
  // question is one `.ps-field`. The first version emitted `<p>` siblings into `.legacy form`, whose
  // two-column label/field grid put two unrelated questions side by side and let a select run three
  // times the width of the input above it.
  assert.match(res.body, /<form class="plugin-settings"/);
  assert.equal((res.body.match(/class="ps-field(?![-\w])/g) ?? []).length, 3, 'one .ps-field per question');
  assert.doesNotMatch(res.body, /<fieldset[^>]*>\s*<legend[^>]*>[^<]*<\/legend>\s*<p>/);
  // The cadence and its time are ONE sentence: same row, no separate heading for "at".
  const marker = res.body.indexOf('class="ps-inline"');
  assert.ok(marker > 0, 'no inline group was drawn');
  const inline = res.body.slice(marker, res.body.indexOf('</div>', marker));
  assert.match(inline, /name="s_digest_cadence"/);
  assert.match(inline, /class="ps-word" for="s_contact_digest_at">at</);
  assert.match(inline, /<input type="time" id="s_contact_digest_at"/);
  // Nothing is stored yet, so the operator's own address is the prefill — and the screen says so
  // rather than pretending it is saved.
  assert.match(res.body, /value="owner@acme\.test"/);
  assert.match(res.body, /Prefilled with your address/);
  assert.equal(settingsRows().length, 0, 'the prefill was persisted without the operator pressing Save');
});

test('S2. a save writes the declared keys, redirects, and audits the keys without their values', async () => {
  const res = await postForm(`/admin/t/${TENANT}/plugins/settings`, {
    plugin: 'contact',
    s_notify_email: 'ops@acme.test',
    s_digest_cadence: 'Every weekday',
    s_digest_at: '07:30',
    timezone: 'Australia/Sydney',
  });
  assert.equal(res.status, 303, res.body);
  const location = decodeURIComponent(String(header(res, 'location')));
  assert.match(location, /saved notify_email, digest_cadence, digest_at, timezone for contact/);

  assert.deepEqual(settingsRows(), [
    { key: 'digest_at', value_json: '"07:30"' },
    { key: 'digest_cadence', value_json: '"Every weekday"' },
    { key: 'notify_email', value_json: '"ops@acme.test"' },
  ]);
  // The zone is the tenant's, not the package's: one row in `cms_settings`, where every scheduled
  // thing on this site reads it.
  assert.deepEqual(siteSettings(), [{ key: 'timezone', value_json: '"Australia/Sydney"' }]);
  assert.ok(auditActions().includes('admin.plugin.settings'), 'no audit row was written');
});

test('S3. a refused answer comes back as a sentence about the question, and nothing is written', async () => {
  const before = settingsRows();
  const beforeSite = siteSettings();
  // An address that is not one. The refusal names the field a person sees, not the key or a length.
  const badEmail = await postForm(`/admin/t/${TENANT}/plugins/settings`, {
    plugin: 'contact',
    s_notify_email: 'not-an-address',
    s_digest_cadence: 'Every day',
    s_digest_at: '07:30',
  });
  assert.equal(badEmail.status, 200, badEmail.body);
  assert.match(badEmail.body, /Not saved: Send the digest to is not an email address/);
  assert.deepEqual(settingsRows(), before, 'a refused value changed a row');

  // A time that is not a time — a hand-crafted POST, because the control cannot produce this.
  const badTime = await postForm(`/admin/t/${TENANT}/plugins/settings`, {
    plugin: 'contact',
    s_notify_email: 'ops@acme.test',
    s_digest_cadence: 'Every day',
    s_digest_at: '25:99',
  });
  assert.equal(badTime.status, 200, badTime.body);
  assert.match(badTime.body, /must be a time of day, like 09:00/);
  assert.deepEqual(settingsRows(), before, 'a refused time changed a row');

  // A zone `Intl` does not know is refused rather than stored and silently ignored later.
  const badZone = await postForm(`/admin/t/${TENANT}/plugins/settings`, {
    plugin: 'contact',
    s_notify_email: 'ops@acme.test',
    s_digest_cadence: 'Every day',
    s_digest_at: '07:30',
    timezone: 'Mars/Olympus_Mons',
  });
  assert.equal(badZone.status, 200, badZone.body);
  assert.match(badZone.body, /is not a time zone this server knows/);
  assert.deepEqual(siteSettings(), beforeSite, 'a refused zone was written');
});

test('S7. a choice that was never offered is refused: the control is the vocabulary', async () => {
  const before = settingsRows();
  const res = await postForm(`/admin/t/${TENANT}/plugins/settings`, {
    plugin: 'contact',
    s_notify_email: 'ops@acme.test',
    s_digest_cadence: 'Every other Tuesday',
    s_digest_at: '07:30',
  });
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /must be one of: Off, Every day, Every weekday, Every Monday, On the 1st of each month/);
  assert.deepEqual(settingsRows(), before, 'an unoffered choice reached the settings table');
});

test('S4. a field the manifest does not declare is not a setting, and is dropped', async () => {
  const res = await postForm(`/admin/t/${TENANT}/plugins/settings`, {
    plugin: 'contact',
    s_notify_email: 'ops@acme.test',
    s_digest_cadence: 'Every day',
    s_digest_at: '08:00',
    s_something_else: 'must not be written',
  });
  assert.equal(res.status, 303, res.body);
  const keys = settingsRows().map((row) => row.key);
  assert.deepEqual(keys, ['digest_at', 'digest_cadence', 'notify_email']);
  assert.ok(!keys.includes('something_else'), 'an undeclared field reached the settings table');
});

test('S5. the same save without the CSRF token is refused and writes nothing', async () => {
  const before = settingsRows();
  const res = await postForm(
    `/admin/t/${TENANT}/plugins/settings`,
    { plugin: 'contact', s_notify_email: 'attacker@example.test' },
    { csrf: false },
  );
  assert.notEqual(res.status, 303);
  assert.deepEqual(settingsRows(), before, 'a save without a CSRF token changed a row');
});

test('S6. enabling a package seeds the operator-email default, so a CLI install is usable from the screen', async () => {
  // A package installed with `skwctl` has no session, so nothing seeded its address. Enable is the
  // moment it starts running — and the moment the operator is standing there.
  const db = new Database(fixture.sitePath(TENANT));
  try {
    db.prepare("DELETE FROM cms_plugin_setting WHERE plugin_id = 'contact' AND key = 'notify_email'").run();
  } finally {
    db.close();
  }
  const res = await postForm(`/admin/t/${TENANT}/plugins/enable`, { plugin: 'contact' });
  assert.equal(res.status, 303, res.body);
  const location = decodeURIComponent(String(header(res, 'location')));
  assert.match(location, /notify_email starts as your address/);
  assert.deepEqual(
    settingsRows().filter((row) => row.key === 'notify_email'),
    [{ key: 'notify_email', value_json: `"${OPERATOR}"` }],
  );
});

/**
 * S8. the stylesheet carries the settings layout, and it is block flow.
 *
 * A CSS regression is invisible to a markup test, and this one bit once already: the first attempt
 * set `grid-template-columns: 1fr` on the form and the legacy `.legacy form` grid still won the
 * cascade for the columns, so the screen came out in two ragged columns while every markup assertion
 * stayed green. The rule is now a stack — `display:block` — which no track template can re-column,
 * and this asserts the declaration is present so nobody quietly deletes it.
 */
test('S8. the settings form is a stack, declared where the stylesheet lives', async () => {
  const { readFileSync } = await import('node:fs');
  const { join: joinPath } = await import('node:path');
  const { REPO } = await import('./helpers/fixture.ts');
  const css = readFileSync(joinPath(REPO, 'app', 'admin', 'ui', 'layout.ts'), 'utf8');
  assert.match(css, /\.legacy form\.plugin-settings\{display:block/, 'the settings form must not be a grid');
  assert.match(css, /\.legacy \.plugin-settings \.ps-field\{display:block/, 'a question is a block');
  assert.match(css, /\.legacy \.plugin-settings input\[type="time"\]\{width:150px/, 'a clock is as wide as a clock');
  assert.match(css, /\.legacy \.plugin-settings \.ps-help\{display:block/, 'help text sits under its own control');
});
