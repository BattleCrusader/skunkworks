/**
 * The contact form's scheduled half: **one digest per slot, nothing when nothing arrived.**
 *
 * Nothing here mocks the host. The install path, the activation path, the per-invocation facade,
 * `hostOp('mail.send')`, the job scheduler and the drain are the same functions the running app
 * uses; the only stand-ins are the SMTP transport at the very end (a socket is not what this file is
 * about) and the clock, which is injected so "07:05 on the 18th" is a fact rather than a wait.
 *
 * What was wrong before this file existed: the package mailed the operator once per submission, and
 * there was no way for an operator to say when — or to stop it. A digest is the answer to both, and
 * the four properties below are what make it safe to run on a timer nobody is watching:
 *
 *   D0  a package declaring a job registers it at activation, and the manifest is the only place a
 *       job name can come from
 *   D1  the job is **host-only**: `/_plugin/contact/digest` is a 404, because a job is not an endpoint
 *   D2  a due slot with two new enquiries enqueues **one** mail carrying both, and advances the
 *       cursor — then a second tick on the same slot sends nothing
 *   D3  a due slot with nothing new sends **no mail at all** and records the slot
 *   D4  the next slot carries only what arrived since — no repeats, no gaps
 *   D5  `SKW_EMAIL_MODE=off` does not consume the backlog: the enquiries go out once mail works
 *   D6  a large backlog is bounded: 25 per digest, the rest named as waiting, cursor exact
 *   D7  the drain renders what the job queued, from the same `cms_mail` row
 *   D8  a job that throws in one tenant does not stop another tenant's job, and a declared-but-
 *       unregistered job is reported rather than skipped in silence
 *   D9  the cadence and the slot arithmetic in a real zone, including a DST transition
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';

import { openAdminWrite } from '../app/db/classes.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { Outbox, type MailTransport } from '../app/mail/outbox.ts';
import { parseManifest, packageRootHash, readManifest } from '../app/plugins/manifest.ts';
import { runEndpoint } from '../app/plugins/endpoint.ts';
import { installPlugin } from '../app/plugins/install.ts';
import { PluginJobRunner } from '../app/plugins/jobs.ts';
import { hostOp } from '../app/plugins/ops.ts';
import { PluginRuntime } from '../app/plugins/runtime.ts';
import { REPO, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call } from './helpers/http.ts';

const TENANT = 'acme';
const OTHER = 'other';
const DIGEST = 'sha256:contact-digest';
const CONTACT = join(REPO, 'plugins', 'contact');
const OPERATOR = 'hello@arnavia.com';
/** 07:05 UTC on a Wednesday — five minutes after a `07:00` slot, so the slot is due. */
const AT = Date.parse('2026-11-18T07:05:00.000Z');

const ENQUIRY = {
  name: 'Ada Lovelace',
  email: 'ada@analytical.example',
  company: 'Analytical Engines',
  message: 'We need the difference engine audited before the quarter closes. Can you quote?',
};

let fixture: Fixture;
let runtime: PluginRuntime;
let clock = AT;
const logs: string[] = [];

function siteDbFile(tenant = TENANT): string {
  return fixture.sitePath(tenant);
}

function install(sourceDir: string, plugin: string, version: string, tenant = TENANT): void {
  const { root } = packageRootHash(sourceDir);
  const report = join(fixture.dir, `${plugin}-${tenant}-report.json`);
  writeFileSync(
    report,
    `${JSON.stringify({ plugin, version, root_hash: root, runner_image_digest: DIGEST, ran_at: new Date().toISOString() }, null, 2)}\n`,
  );
  installPlugin({
    siteDb: siteDbFile(tenant),
    pluginsRoot: join(fixture.dir, 'plugins'),
    sourceDir,
    allowUnsigned: true,
    testReportPath: report,
    runnerImageDigest: DIGEST,
  });
}

/** `settings.set` exactly as the admin surface issues it: a host op against the installed manifest. */
function setSetting(key: string, value: unknown, plugin = 'contact', tenant = TENANT): void {
  const db = openAdminWrite(siteDbFile(tenant), 5000);
  try {
    hostOp({ db, tenant, plugin, manifest: readManifest(CONTACT), emailMode: 'smtp' }, 'settings.set', { key, value });
  } finally {
    db.close();
  }
}

/** The site's clock, exactly as the Plugins screen writes it: one row in `cms_settings`. */
function setTimezone(zone = 'UTC', tenant = TENANT): void {
  const db = openAdminWrite(siteDbFile(tenant), 5000);
  try {
    db.prepare(
      `INSERT INTO cms_settings (key, value_json, type) VALUES ('timezone', ?, 'string')
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    ).run(JSON.stringify(zone));
  } finally {
    db.close();
  }
}

/** What an operator does on the screen: pick a cadence, pick a time. */
function setDigest(cadence = 'Every day', at = '07:00', tenant = TENANT): void {
  setSetting('digest_cadence', cadence, 'contact', tenant);
  setSetting('digest_at', at, 'contact', tenant);
}

function read<T>(query: (db: Database.Database) => T, tenant = TENANT): T {
  const db = new Database(siteDbFile(tenant), { readonly: true });
  try {
    return query(db);
  } finally {
    db.close();
  }
}

interface MailRow {
  id: number;
  to_email: string;
  template: string;
  subject: string;
  status: string;
  vars_json: string;
}

function mailRows(tenant = TENANT): MailRow[] {
  return read(
    (db) => db.prepare('SELECT id, to_email, template, subject, status, vars_json FROM cms_mail ORDER BY id').all() as MailRow[],
    tenant,
  );
}

function messageCount(tenant = TENANT): number {
  return read((db) => Number((db.prepare('SELECT COUNT(*) AS n FROM p_contact_message').get() as { n: number }).n), tenant);
}

function digestState(tenant = TENANT): { last_message_id: number; last_run_at: string | null } | undefined {
  return read(
    (db) => db.prepare('SELECT last_message_id, last_run_at FROM p_contact_digest ORDER BY id LIMIT 1').get() as
      | { last_message_id: number; last_run_at: string | null }
      | undefined,
    tenant,
  );
}

/** A message straight into the table, for volume and for "this arrived last week" fixtures. */
function insertMessage(fields: Partial<typeof ENQUIRY> & { name?: string } = {}, tenant = TENANT): number {
  const db = openAdminWrite(siteDbFile(tenant), 5000);
  try {
    const info = db
      .prepare(
        `INSERT INTO p_contact_message (name, email, company, message, status, created_at)
         VALUES (?, ?, ?, ?, 'new', ?)`,
      )
      .run(
        fields.name ?? 'Grace Hopper',
        fields.email ?? 'grace@navy.example',
        fields.company ?? 'US Navy',
        fields.message ?? 'Can you ship a scheduler before the quarter closes?',
        new Date(clock - 60_000).toISOString(),
      );
    return Number(info.lastInsertRowid);
  } finally {
    db.close();
  }
}

/** The endpoint exactly as the `/_plugin/*` route calls it. */
async function submit(body: string, tenant = TENANT): Promise<Record<string, unknown>> {
  const db = openAdminWrite(siteDbFile(tenant), 5000);
  try {
    return (await runEndpoint(runtime, {
      db,
      tenant,
      plugin: 'contact',
      endpoint: 'submit',
      method: 'POST',
      url: '/_plugin/contact/submit',
      body,
    })) as Record<string, unknown>;
  } finally {
    db.close();
  }
}

function runner(overrides: { tenants?: readonly string[] } = {}): PluginJobRunner {
  const tenants = overrides.tenants ?? [TENANT];
  return new PluginJobRunner({
    runtime,
    tenants: () => tenants,
    open: (tenant) => openAdminWrite(siteDbFile(tenant), 5000),
    now: () => clock,
    log: (line) => logs.push(line),
  });
}

function parseVars(row: MailRow): Record<string, unknown> {
  return JSON.parse(row.vars_json) as Record<string, unknown>;
}

before(() => {
  fixture = makeFixture({
    specs: [
      { key: TENANT, hosts: ['acme.test'], title: 'Acme' },
      { key: OTHER, hosts: ['other.test'], title: 'Other' },
    ],
  });
  // Every job runs with the site's clock, so the fixture needs one before it ticks.
  setTimezone('UTC', TENANT);
  setTimezone('UTC', OTHER);
  install(CONTACT, 'contact', '2.0.0');
  install(CONTACT, 'contact', '2.0.0', OTHER);
  // The second tenant's row says enabled, but this process never activated it — the "row says
  // enabled, nothing is loaded" state the tick has to name rather than skip in silence (D8).
  {
    const db = openAdminWrite(siteDbFile(OTHER), 5000);
    try {
      db.prepare("UPDATE cms_plugin_installed SET enabled = 1 WHERE plugin_id = 'contact'").run();
    } finally {
      db.close();
    }
  }
  runtime = new PluginRuntime({ dataDir: fixture.dir, emailMode: 'smtp', now: () => clock, log: (line) => logs.push(line) });
});

after(() => {
  fixture.cleanup();
});

test('D0. contact declares a digest job and registers it at activation; its settings are the two the operator answers', async () => {
  const manifest = readManifest(CONTACT);
  assert.deepEqual(manifest.jobs, [{ name: 'digest' }]);
  assert.deepEqual(
    manifest.settings.map((setting) => [setting.key, setting.type, setting.defaultFrom ?? null]),
    [
      ['notify_email', 'email', 'operator-email'],
      ['digest_cadence', 'select', null],
      ['digest_at', 'time', null],
    ],
  );
  // The digest's cursors live in a table, not in settings: settings are the operator's answers and
  // the Plugins screen shows every one of them.
  assert.ok(manifest.tables.some((table) => table.name === 'p_contact_digest' && table.export === 'empty'));

  const activation = await runtime.enable(TENANT, 'contact');
  assert.deepEqual(activation.jobs, ['digest']);
  assert.deepEqual(activation.endpoints, ['POST submit']);
});

test('D1. a job is host-only: /_plugin/contact/digest is the tenant’s ordinary 404', async () => {
  const app: AppHandle = await buildApp({
    env: loadEnv({
      ...fixture.env,
      SKW_EMAIL_MODE: 'smtp',
      // Deliberately unresolvable: a stray send must fail loudly rather than reach a stranger. The
      // drain timer is 30 s and this test closes in well under one.
      SKW_SMTP_URL: 'smtp://relay.invalid:587',
      SKW_MAIL_FROM: 'noreply@acme.test',
    }),
  });
  await app.app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    const res = await call({ port, path: '/_plugin/contact/digest', method: 'POST', host: 'acme.test', body: '{}' });
    // Undeclared endpoint: indistinguishable from a path this tenant does not have.
    assert.equal(res.status, 404, res.body);
  } finally {
    await app.close();
  }
});

test('D2. a due slot sends exactly one message carrying both enquiries, then the same slot sends nothing', async () => {
  setSetting('notify_email', OPERATOR);
  setDigest('Every day', '07:00');

  const before = mailRows().length;
  assert.deepEqual(await submit(JSON.stringify(ENQUIRY)), { ok: true });
  assert.deepEqual(await submit(JSON.stringify({ ...ENQUIRY, name: 'Mary Jackson', company: 'NASA' })), { ok: true });

  const report = await runner().runOnce();
  const digest = report.jobs[0];
  assert.equal(digest?.status, 'ran', JSON.stringify(report, null, 2));
  const result = digest?.result as { sent: boolean; count: number; more: boolean; slot: string; mail_id: number | null };
  assert.equal(result.sent, true);
  assert.equal(result.count, 2);
  assert.equal(result.more, false);
  assert.equal(result.slot, '2026-11-18T07:00:00.000Z');
  assert.equal(typeof result.mail_id, 'number', 'the report does not name the queued row');

  const rows = mailRows();
  assert.equal(rows.length, before + 1, `expected one digest, got ${String(rows.length - before)}`);
  const row = rows.at(-1) as MailRow;
  assert.equal(row.to_email, OPERATOR);
  assert.equal(row.template, 'contact-digest');
  assert.equal(row.status, 'queued');
  assert.equal(row.subject, '2 new enquiries');

  const text = String(parseVars(row).text ?? '');
  assert.match(text, /Ada Lovelace — Analytical Engines/);
  assert.match(text, /Reply to: ada@analytical\.example/);
  assert.match(text, /Mary Jackson — NASA/);
  assert.ok(text.includes(ENQUIRY.message), 'the body does not carry the visitor’s message');
  assert.match(text, /\/admin\/t\/acme\/messages/);

  // The cursor is the newest id, and the slot is recorded — so a second tick has nothing to do.
  const newest = read((db) => Number((db.prepare('SELECT max(id) AS n FROM p_contact_message').get() as { n: number }).n));
  const state = digestState();
  assert.equal(state?.last_message_id, newest);
  assert.equal(state?.last_run_at, '2026-11-18T07:00:00.000Z');

  const again = await runner().runOnce();
  assert.deepEqual(again.jobs[0]?.result, { skipped: 'not-due' });
  assert.equal(mailRows().length, before + 1, 'a second tick on the same slot queued a second digest');
});

test('D3. a due slot with nothing new sends no mail at all, and says so', async () => {
  // Tomorrow's slot, nothing stored since the last digest.
  clock = Date.parse('2026-11-19T07:02:00.000Z');
  const before = mailRows().length;
  const stateBefore = digestState();

  const report = await runner().runOnce();
  assert.deepEqual(report.jobs[0]?.result, { sent: false, reason: 'empty', slot: '2026-11-19T07:00:00.000Z' });
  assert.equal(mailRows().length, before, 'a digest was queued with nothing in it');

  // The slot is recorded so the next tick does not re-ask; the cursor does not move.
  const state = digestState();
  assert.equal(state?.last_run_at, '2026-11-19T07:00:00.000Z');
  assert.equal(state?.last_message_id, stateBefore?.last_message_id);
});

test('D4. the next slot carries only what arrived since — no repeats, no gaps', async () => {
  const first = insertMessage({ name: 'Katherine Johnson', company: 'NASA' });
  const second = insertMessage({ name: 'Dorothy Vaughan', company: 'NASA' });

  clock = Date.parse('2026-11-20T07:01:00.000Z');
  const before = mailRows().length;
  const report = await runner().runOnce();
  assert.equal(report.jobs[0]?.result && (report.jobs[0].result as { sent: boolean }).sent, true);
  assert.equal(mailRows().length, before + 1);

  const row = mailRows().at(-1) as MailRow;
  const text = String(parseVars(row).text ?? '');
  assert.equal(row.subject, '2 new enquiries');
  assert.match(text, /Katherine Johnson/);
  assert.match(text, /Dorothy Vaughan/);
  assert.ok(!text.includes('Ada Lovelace'), 'the digest repeated a message from an earlier slot');
  assert.equal(digestState()?.last_message_id, second);
  assert.ok(first < second);
});

test('D5. with mail off the backlog is not consumed: it goes out once mail works', async () => {
  insertMessage({ name: 'Annie Easley', company: 'NASA' });
  clock = Date.parse('2026-11-21T07:01:00.000Z');

  // The live box: `SKW_EMAIL_MODE=off`. A separate runtime over the same install.
  const offLogs: string[] = [];
  const offRuntime = new PluginRuntime({ dataDir: fixture.dir, emailMode: 'off', now: () => clock, log: (line) => offLogs.push(line) });
  await offRuntime.enable(TENANT, 'contact');
  const offRunner = new PluginJobRunner({
    runtime: offRuntime,
    tenants: () => [TENANT],
    open: (tenant) => openAdminWrite(siteDbFile(tenant), 5000),
    now: () => clock,
    log: (line) => offLogs.push(line),
  });

  const before = mailRows().length;
  const cursorBefore = digestState()?.last_message_id;
  const report = await offRunner.runOnce();
  const result = report.jobs[0]?.result as { sent: boolean; reason: string; pending: number };
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'mail-refused');
  assert.equal(mailRows().length, before, 'a row was queued although the host refused mail');
  assert.equal(digestState()?.last_message_id, cursorBefore, 'the cursor moved without a digest being queued');
  assert.ok(
    offLogs.some((line) => /digest NOT queued/.test(line) && /SKW_E_PL_MAIL/.test(line)),
    `no refusal was logged; lines were:\n${offLogs.join('\n')}`,
  );

  // Mail works again, and the same enquiry is still pending for the next slot.
  clock = Date.parse('2026-11-22T07:01:00.000Z');
  const recovered = await runner().runOnce();
  assert.equal((recovered.jobs[0]?.result as { sent: boolean }).sent, true);
  const row = mailRows().at(-1) as MailRow;
  assert.match(String(parseVars(row).text ?? ''), /Annie Easley/);
});

test('D6. a large backlog is bounded: 25 per digest, the rest named as waiting, the cursor exact', async () => {
  const ids: number[] = [];
  for (let i = 0; i < 30; i += 1) ids.push(insertMessage({ name: `Sender ${String(i + 1).padStart(2, '0')}` }));
  clock = Date.parse('2026-11-23T07:01:00.000Z');

  const before = mailRows().length;
  const report = await runner().runOnce();
  const result = report.jobs[0]?.result as { sent: boolean; count: number; more: boolean };
  assert.equal(result.sent, true);
  assert.equal(result.count, 25);
  assert.equal(result.more, true);
  assert.equal(mailRows().length, before + 1);

  const row = mailRows().at(-1) as MailRow;
  const text = String(parseVars(row).text ?? '');
  assert.equal(row.subject, '25 new enquiries');
  assert.match(text, /More enquiries are waiting/);
  assert.equal(digestState()?.last_message_id, ids[24], 'the cursor did not stop at the last message included');

  // The remainder belongs to the next slot, and carries the five that were left.
  clock = Date.parse('2026-11-24T07:01:00.000Z');
  const next = await runner().runOnce();
  const nextResult = next.jobs[0]?.result as { sent: boolean; count: number; more: boolean; slot: string };
  assert.equal(nextResult.sent, true);
  assert.equal(nextResult.count, 5);
  assert.equal(nextResult.more, false);
  assert.equal(nextResult.slot, '2026-11-24T07:00:00.000Z');
  assert.match(String(parseVars(mailRows().at(-1) as MailRow).text ?? ''), /Sender 30/);
  assert.equal(digestState()?.last_message_id, ids[29]);
});

test('D7. the existing drain renders and sends the digest an operator reads', async () => {
  const rows = mailRows();
  const row = rows.at(-1) as MailRow;
  const sent: { to: string; subject: string; text: string }[] = [];
  const transport: MailTransport = {
    async send(mail) {
      if (mail.id !== row.id) return { providerId: `skip-${String(mail.id)}` };
      sent.push({ to: mail.to, subject: mail.subject, text: mail.text });
      return { providerId: `fake-${String(mail.id)}` };
    },
  };
  const db = openAdminWrite(siteDbFile(), 5000);
  try {
    await new Outbox(db, transport).drain();
  } finally {
    db.close();
  }
  assert.equal(sent.length, 1, 'the transport was not handed the queued digest');
  assert.equal(sent[0]?.to, OPERATOR);
  assert.equal(sent[0]?.subject, '5 new enquiries');
  assert.match(sent[0]?.text ?? '', /Sender 26/);
});

test('D8. one broken package does not stop another tenant, and a declared-but-unregistered job is reported', async () => {
  // The second tenant has the same package installed but never activated in this runtime, which is
  // the "row says enabled, nothing is loaded" state — the tick must say so with a code.
  const report = await runner({ tenants: [TENANT, OTHER] }).runOnce();
  const acme = report.jobs.filter((job) => job.tenant === TENANT);
  const other = report.jobs.find((job) => job.tenant === OTHER);
  assert.ok(acme.length > 0, 'the tick skipped the tenant that was loaded');
  assert.equal(other?.status, 'not-registered');
  assert.equal(other?.error?.code, 'SKW_E_PL_UNAVAILABLE');

  // A tenant whose file cannot be opened is skipped, not fatal: the report still has the healthy one.
  const broken = new PluginJobRunner({
    runtime,
    tenants: () => ['nope', TENANT],
    open: (tenant) => {
      if (tenant === 'nope') throw new Error('SKW_E_PLT_TENANT_UNKNOWN: no such tenant');
      return openAdminWrite(siteDbFile(tenant), 5000);
    },
    now: () => clock,
    log: (line) => logs.push(line),
  });
  const report2 = await broken.runOnce();
  assert.ok(report2.jobs.some((job) => job.tenant === TENANT));
  assert.ok(logs.some((line) => /nope skipped/.test(line)));
});

test('D9. the cadence asks a calendar question in the site\'s zone, and DST is the zone\'s answer', () => {
  // The two functions the job is built from, imported as a person would use them. No network, no
  // fake timer: an instant in, an instant out, and the assertion converts the answer back to wall
  // time in the zone — so it is the zone database that says whether the arithmetic is right, not
  // a hand-computed offset that would agree with a bug in the same direction.
  const wall = (ms: number, zone: string): string =>
    new Intl.DateTimeFormat('en-AU', {
      timeZone: zone,
      hour12: false,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ms));

  return import(pathToFileURL(join(CONTACT, 'index.mjs')).href).then((mod: unknown) => {
    const api = mod as {
      CADENCES: Record<string, { days: string }>;
      DIGEST_OFF: string;
      dueSlot: (nowMs: number, opts: { cadence: { days: string }; at: string; zone: string }) => number;
    };
    const daily = api.CADENCES['Every day'];
    const monday = api.CADENCES['Every Monday'];
    const first = api.CADENCES['On the 1st of each month'];
    const weekdays = api.CADENCES['Every weekday'];
    assert.equal(api.DIGEST_OFF, 'Off');
    assert.equal(daily?.days, 'all');

    // 07:05 UTC on Saturday 21 Nov 2026: the most recent 07:00 slot is that morning.
    assert.equal(
      new Date(api.dueSlot(Date.parse('2026-11-21T07:05:00Z'), { cadence: daily!, at: '07:00', zone: 'UTC' })).toISOString(),
      '2026-11-21T07:00:00.000Z',
    );
    // 06:59 UTC: yesterday's slot.
    assert.equal(
      new Date(api.dueSlot(Date.parse('2026-11-21T06:59:00Z'), { cadence: daily!, at: '07:00', zone: 'UTC' })).toISOString(),
      '2026-11-20T07:00:00.000Z',
    );

    // Same instant, read in Sydney (UTC+11 in November): 07:00 local was 20:00 UTC the day before.
    const sydney = api.dueSlot(Date.parse('2026-11-21T07:05:00Z'), { cadence: daily!, at: '07:00', zone: 'Australia/Sydney' });
    assert.equal(new Date(sydney).toISOString(), '2026-11-20T20:00:00.000Z');
    assert.match(wall(sydney, 'Australia/Sydney'), /07:00$/);

    // The whole point of the zone: 09:00 means nine in the morning where the operator is, not UTC.
    const nine = api.dueSlot(Date.parse('2026-11-21T07:05:00Z'), { cadence: daily!, at: '09:00', zone: 'Australia/Sydney' });
    assert.match(wall(nine, 'Australia/Sydney'), /09:00$/);
    assert.notEqual(wall(nine, 'Australia/Sydney'), wall(nine, 'UTC'));

    // Weekdays skip the weekend: asked on Saturday, the answer is Friday's slot.
    const saturday = Date.parse('2026-11-21T07:05:00Z');
    const friday = api.dueSlot(saturday, { cadence: weekdays!, at: '07:00', zone: 'UTC' });
    assert.equal(new Date(friday).toISOString(), '2026-11-20T07:00:00.000Z');
    // ...and on Monday morning the answer is that same Monday, not last week's.
    const mondayMorning = Date.parse('2026-11-23T07:05:00Z');
    assert.equal(
      new Date(api.dueSlot(mondayMorning, { cadence: weekdays!, at: '07:00', zone: 'UTC' })).toISOString(),
      '2026-11-23T07:00:00.000Z',
    );

    // Weekly: asked on a Wednesday, the most recent Monday 09:00.
    const wednesday = api.dueSlot(Date.parse('2026-11-18T07:05:00Z'), { cadence: monday!, at: '09:00', zone: 'UTC' });
    assert.equal(new Date(wednesday).toISOString(), '2026-11-16T09:00:00.000Z');
    assert.match(wall(wednesday, 'UTC'), /^Mon/);

    // Monthly on the 1st: asked on the 21st, the answer is the 1st of the same month...
    const onThe21st = api.dueSlot(Date.parse('2026-11-21T07:05:00Z'), { cadence: first!, at: '09:00', zone: 'UTC' });
    assert.equal(new Date(onThe21st).toISOString(), '2026-11-01T09:00:00.000Z');
    // ...and asked on the 1st before 09:00, it is the 1st of the *previous* month, because this
    // month's slot has not happened yet.
    const earlyOnTheFirst = api.dueSlot(Date.parse('2026-11-01T08:00:00Z'), { cadence: first!, at: '09:00', zone: 'UTC' });
    assert.equal(new Date(earlyOnTheFirst).toISOString(), '2026-10-01T09:00:00.000Z');
    // February has no 30th and no 31st: the walk is day-of-month arithmetic, so it crosses a short
    // month without a table.
    const march = api.dueSlot(Date.parse('2026-03-01T08:00:00Z'), { cadence: first!, at: '09:00', zone: 'UTC' });
    assert.equal(new Date(march).toISOString(), '2026-02-01T09:00:00.000Z');

    // DST, both directions, in Sydney. 2026 transitions: forward on 4 Oct (02:00 -> 03:00), back on
    // 5 Apr (03:00 -> 02:00). A 09:00 slot is unaffected in wall-clock terms, which is exactly the
    // property that matters: the digest must stay at nine in the morning on both sides of it.
    const beforeDst = api.dueSlot(Date.parse('2026-10-03T00:00:00Z'), { cadence: daily!, at: '09:00', zone: 'Australia/Sydney' });
    const afterDst = api.dueSlot(Date.parse('2026-10-05T00:00:00Z'), { cadence: daily!, at: '09:00', zone: 'Australia/Sydney' });
    assert.match(wall(beforeDst, 'Australia/Sydney'), /09:00$/);
    assert.match(wall(afterDst, 'Australia/Sydney'), /09:00$/);
    // The UTC instants differ by the offset change: +10:00 before, +11:00 after.
    assert.equal(new Date(beforeDst).toISOString(), '2026-10-02T23:00:00.000Z');
    assert.equal(new Date(afterDst).toISOString(), '2026-10-04T22:00:00.000Z');

    // A wall time that does not exist (02:30 on the spring-forward morning) resolves to the instant
    // the clock jumped past it, and never to NaN: a nonexistent minute must not stop the timer.
    const skipped = api.dueSlot(Date.parse('2026-10-04T05:00:00Z'), { cadence: daily!, at: '02:30', zone: 'Australia/Sydney' });
    assert.ok(Number.isFinite(skipped));
    assert.ok(skipped <= Date.parse('2026-10-04T05:00:00Z'));
  });
});

test('D10. a manifest may declare jobs and an operator-email default — and nothing else', () => {
  const base = { id: 'demo', version: '1.0.0', main: 'index.mjs', hooks: [], capabilities: [], tables: [] };
  const codeOf = (fn: () => unknown): string | undefined => {
    try {
      fn();
      return undefined;
    } catch (err) {
      return (err as { code?: string }).code;
    }
  };
  assert.deepEqual(parseManifest({ ...base, jobs: [{ name: 'digest' }] }).jobs, [{ name: 'digest' }]);
  assert.deepEqual(
    parseManifest({ ...base, settings: [{ key: 'notify_email', type: 'string', defaultFrom: 'operator-email' }] }).settings,
    [{ key: 'notify_email', type: 'string', defaultFrom: 'operator-email' }],
  );
  assert.equal(codeOf(() => parseManifest({ ...base, jobs: [{ name: 'Digest' }] })), 'SKW_E_PL_REJECTED');
  assert.throws(() => parseManifest({ ...base, jobs: [{ name: 'a' }, { name: 'a' }] }), /declared twice/);
  assert.throws(() => parseManifest({ ...base, settings: [{ key: 'x', type: 'string', defaultFrom: 'the-owner' }] }), /defaultFrom/);
  assert.throws(() => parseManifest({ ...base, settings: [{ key: 'x', type: 'int', defaultFrom: 'operator-email' }] }), /text setting/);
  // The new vocabulary: a time is a time, a choice declares its choices, and an address is not free
  // text with a length on it. Each refusal is the reason a package cannot ask badly.
  assert.deepEqual(
    parseManifest({ ...base, settings: [{ key: 'digest_at', type: 'time', label: 'at', required: true }] }).settings,
    [{ key: 'digest_at', type: 'time', label: 'at', required: true }],
  );
  assert.deepEqual(
    parseManifest({ ...base, settings: [{ key: 'c', type: 'select', options: ['Off', 'Every day'] }] }).settings,
    [{ key: 'c', type: 'select', options: ['Off', 'Every day'] }],
  );
  assert.throws(() => parseManifest({ ...base, settings: [{ key: 'c', type: 'select' }] }), /must declare its options/);
  assert.throws(() => parseManifest({ ...base, settings: [{ key: 'c', type: 'select', options: ['Off'] }] }), /2–24 options/);
  assert.throws(() => parseManifest({ ...base, settings: [{ key: 'c', type: 'select', options: ['Off', 'Off'] }] }), /offered twice/);
  assert.throws(() => parseManifest({ ...base, settings: [{ key: 'c', type: 'string', options: ['a', 'b'] }] }), /belongs to a select/);
  assert.throws(() => parseManifest({ ...base, settings: [{ key: 't', type: 'time', max: 24 }] }), /asked as a time/);
  assert.throws(() => parseManifest({ ...base, settings: [{ key: 't', type: 'clock' }] }), /is not valid/);
  // The declaration is a list of names, not a schedule: a package that tries to own the clock is
  // refused, because when a job runs is the operator's answer per tenant.
  assert.throws(() => parseManifest({ ...base, jobs: [{ name: 'digest', every: '24h' }] }), /declares its name only/);
});

/** `mail_id` is a number the queue assigned; the exact value is not this file's business. */

test('D11. the body budget carries a contiguous prefix and never steps the cursor over an omission', async () => {
  // Twenty-five enquiries with the longest message the form accepts. Each block quotes at most 1,200
  // characters, so 25 of them overflow the 24 KiB body budget: the digest must stop cleanly at the
  // last one it carried — not skip a long one in the middle and keep a short one after it, which
  // would move the cursor past a message that was never sent.
  const long = 'x'.repeat(4_000);
  const ids: number[] = [];
  for (let i = 0; i < 25; i += 1) ids.push(insertMessage({ name: `Long ${String(i + 1)}`, message: `${String(i + 1)}|${long}` }));
  clock = Date.parse('2026-11-25T07:01:00.000Z');

  const before = mailRows().length;
  const report = await runner().runOnce();
  const first = report.jobs[0]?.result as { sent: boolean; count: number; more: boolean };
  assert.equal(first.sent, true);
  assert.ok(first.count >= 1 && first.count < 25, `expected a partial digest, got ${String(first.count)} of 25`);
  assert.equal(first.more, true);
  assert.equal(mailRows().length, before + 1);

  const firstRow = mailRows().at(-1) as MailRow;
  const firstText = String(parseVars(firstRow).text ?? '');
  assert.ok(firstText.length <= 24_000, `the body is ${String(firstText.length)} chars, over the budget`);
  assert.match(firstText, /More enquiries are waiting/);
  assert.equal(digestState()?.last_message_id, ids[first.count - 1], 'the cursor is not the last carried message');

  // The rest are still owed, and arrive in the next slot — in order, with nothing repeated.
  clock = Date.parse('2026-11-26T07:01:00.000Z');
  const second = await runner().runOnce();
  const rest = second.jobs[0]?.result as { sent: boolean; count: number };
  assert.equal(rest.sent, true);
  assert.equal(rest.count, 25 - first.count);
  const secondText = String(parseVars(mailRows().at(-1) as MailRow).text ?? '');
  assert.ok(!secondText.includes(`${String(first.count)}|`), 'the second digest repeated a message from the first');
  assert.match(secondText, /25\|/);
  assert.equal(digestState()?.last_message_id, ids[24]);
});
