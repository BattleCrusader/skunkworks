/**
 * The outbox against a real `site.db`, with a transport that is a list instead of a socket.
 *
 * The transport is the only thing faked: claim, lease, suppression, backoff, giving up and
 * crash-recovery all run against the shipped SQL. A test that mocked the database too would be
 * testing the mock.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  BATCH,
  MAX_ATTEMPTS,
  Outbox,
  RECLAIM_AFTER_MS,
  type MailTransport,
  type OutgoingMail,
} from '../app/mail/outbox.ts';
import { renderMail } from '../app/mail/templates.ts';
import { parseSmtpUrl } from '../app/mail/transport.ts';
import { SCHEMA } from './helpers/fixture.ts';

const root = mkdtempSync(join(tmpdir(), 'skw-mail-'));
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function db(): Database.Database {
  const path = join(root, `outbox-${(n += 1)}.db`);
  const handle = new Database(path);
  handle.exec(readFileSync(join(SCHEMA, 'site.sql'), 'utf8'));
  return handle;
}

interface Recorder extends MailTransport {
  readonly sent: OutgoingMail[];
  fail: Error | null;
  attempts: number;
}

function recorder(): Recorder {
  const sent: OutgoingMail[] = [];
  return {
    sent,
    fail: null,
    attempts: 0,
    async send(mail) {
      (this as unknown as { attempts: number }).attempts += 1;
      if (this.fail !== null) throw this.fail;
      sent.push(mail);
      return { providerId: `<${mail.id}@test>` };
    },
  };
}

function enqueue(
  handle: Database.Database,
  over: Partial<{ to: string; template: string; vars: string; key: string; at: string; subject: string }> = {},
): number {
  const info = handle
    .prepare(
      `INSERT INTO cms_mail (to_email, template, subject, vars_json, idempotency_key, created_at, next_attempt_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      over.to ?? 'sam@example.test',
      over.template ?? 'verify_email',
      over.subject ?? 'Confirm your email',
      over.vars ?? JSON.stringify({ verify_path: '/portal/verify?token=abc', ttl_hours: 24 }),
      over.key ?? `k-${Math.random().toString(16).slice(2)}`,
      over.at ?? new Date().toISOString(),
      null,
    );
  return Number(info.lastInsertRowid);
}

test('M1 — a queued row is rendered, sent once, and recorded with the provider id', async () => {
  const handle = db();
  const transport = recorder();
  const outbox = new Outbox(handle, transport);
  const id = enqueue(handle);

  const report = await outbox.drain();
  assert.deepEqual(report, { claimed: 1, sent: 1, failed: 0, suppressed: 0, skipped: 0 });
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0]?.to, 'sam@example.test');
  assert.match(transport.sent[0]?.text ?? '', /\/portal\/verify\?token=abc/);

  const row = handle.prepare('SELECT status, provider_id, attempts, sent_at FROM cms_mail WHERE id = ?').get(id) as {
    status: string;
    provider_id: string;
    attempts: number;
    sent_at: string;
  };
  assert.equal(row.status, 'sent');
  assert.equal(row.provider_id, `<${id}@test>`);
  assert.equal(row.attempts, 1);
  assert.ok(row.sent_at !== null);

  // A second drain finds nothing: the row is not queued any more.
  assert.deepEqual(await outbox.drain(), { claimed: 0, sent: 0, failed: 0, suppressed: 0, skipped: 0 });
  assert.equal(transport.sent.length, 1, 'a sent message is never sent twice');
  handle.close();
});

test('M2 — an unsubscribed address is suppressed at send time, not at enqueue time', async () => {
  const handle = db();
  const transport = recorder();
  const id = enqueue(handle);
  handle.prepare("INSERT INTO cms_mail_suppression (email, reason) VALUES (?, 'unsubscribe')").run('sam@example.test');

  const report = await new Outbox(handle, transport).drain();
  assert.deepEqual(report, { claimed: 1, sent: 0, failed: 0, suppressed: 1, skipped: 0 });
  assert.equal(transport.sent.length, 0, 'the row was written before the unsubscribe and still must not go');
  assert.equal((handle.prepare('SELECT status FROM cms_mail WHERE id = ?').get(id) as { status: string }).status, 'suppressed');
  handle.close();
});

test('M3 — a failed send is retried with backoff, and the row goes back to queued', async () => {
  const handle = db();
  const transport = recorder();
  transport.fail = new Error('connection refused');
  const id = enqueue(handle);

  const report = await new Outbox(handle, transport).drain();
  assert.deepEqual(report, { claimed: 1, sent: 0, failed: 0, suppressed: 0, skipped: 1 });
  const row = handle.prepare('SELECT status, attempts, next_attempt_at, last_error FROM cms_mail WHERE id = ?').get(id) as {
    status: string;
    attempts: number;
    next_attempt_at: string;
    last_error: string;
  };
  assert.equal(row.status, 'queued');
  assert.equal(row.attempts, 1);
  assert.equal(row.last_error, 'connection refused');
  assert.ok(new Date(row.next_attempt_at).getTime() > Date.now(), 'the backoff is in the future');

  // Not yet due: a drain at the same instant does nothing rather than hammering the server.
  assert.equal((await new Outbox(handle, transport).drain()).claimed, 0);
  handle.close();
});

test('M4 — after the last attempt the row is failed, with the reason kept', async () => {
  const handle = db();
  const transport = recorder();
  transport.fail = new Error('550 mailbox unavailable');
  const id = enqueue(handle);
  handle.prepare('UPDATE cms_mail SET attempts = ? WHERE id = ?').run(MAX_ATTEMPTS - 1, id);

  const report = await new Outbox(handle, transport).drain();
  assert.deepEqual(report, { claimed: 1, sent: 0, failed: 1, suppressed: 0, skipped: 0 });
  const row = handle.prepare('SELECT status, attempts, last_error FROM cms_mail WHERE id = ?').get(id) as {
    status: string;
    attempts: number;
    last_error: string;
  };
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, MAX_ATTEMPTS);
  assert.match(row.last_error, /550/);
  handle.close();
});

test('M5 — a row stuck in sending is reclaimed after the lease, and a live lease is not stolen', async () => {
  const handle = db();
  const transport = recorder();
  const stuck = enqueue(handle);
  const live = enqueue(handle);
  const now = Date.now();
  handle.prepare("UPDATE cms_mail SET status = 'sending', next_attempt_at = ? WHERE id = ?").run(
    new Date(now - 1_000).toISOString(),
    stuck,
  );
  handle.prepare("UPDATE cms_mail SET status = 'sending', next_attempt_at = ? WHERE id = ?").run(
    new Date(now + RECLAIM_AFTER_MS).toISOString(),
    live,
  );

  const report = await new Outbox(handle, transport).drain();
  assert.deepEqual(report, { claimed: 1, sent: 1, failed: 0, suppressed: 0, skipped: 0 });
  assert.equal(transport.sent[0]?.id, stuck);
  const statuses = handle.prepare('SELECT id, status FROM cms_mail ORDER BY id').all() as { id: number; status: string }[];
  assert.deepEqual(statuses, [
    { id: stuck, status: 'sent' },
    { id: live, status: 'sending' },
  ]);
  handle.close();
});

test('M6 — a template this build cannot render is failed, not left queued forever', async () => {
  const handle = db();
  const transport = recorder();
  const id = enqueue(handle, { template: 'verify_email', vars: '{}' });
  const unknown = enqueue(handle, { template: 'promo_blast', vars: '{}' });

  const report = await new Outbox(handle, transport).drain();
  assert.equal(report.sent, 1, 'verify_email renders without a path: a missing var is empty, not fatal');
  assert.equal(report.failed, 1);
  const row = handle.prepare('SELECT status, last_error FROM cms_mail WHERE id = ?').get(unknown) as {
    status: string;
    last_error: string;
  };
  assert.equal(row.status, 'failed');
  assert.match(row.last_error, /unknown template/);
  handle.close();
});

test('M7 — one drain claims at most a batch, and the rest wait for the next one', async () => {
  const handle = db();
  const transport = recorder();
  for (let i = 0; i < BATCH + 3; i += 1) enqueue(handle, { key: `batch-row-${i}` });
  const outbox = new Outbox(handle, transport);

  const first = await outbox.drain();
  assert.equal(first.claimed, BATCH);
  const second = await outbox.drain();
  assert.equal(second.claimed, 3);
  assert.equal(transport.sent.length, BATCH + 3);
  handle.close();
});

test('M8 — renderMail states the fact in both templates and the subject carries the role title', () => {
  const verify = renderMail('verify_email', { verify_path: '/portal/verify?token=x', ttl_hours: 24 });
  assert.match(verify.subject, /Confirm your email/);
  assert.match(verify.text, /within 24 hours/);

  const exists = renderMail('account_exists', {});
  assert.match(exists.text, /already exists/);

  const match = renderMail('job_match', { job_title: 'Fractional CTO', company: 'Acme', job_path: '/jobs/1' });
  assert.equal(match.subject, 'New fractional role: Fractional CTO at Acme');
  assert.match(match.text, /\/jobs\/1/);
  assert.match(match.text, /discoverable/, 'the mail says why it was sent, which is the unsubscribe argument');
});

test('M9 — the SMTP URL is parsed, never guessed, and a bad scheme is refused by name', () => {
  assert.deepEqual(parseSmtpUrl('smtp://user:p%40ss@mail.example.test:587'), {
    host: 'mail.example.test',
    port: 587,
    secure: false,
    auth: { user: 'user', pass: 'p@ss' },
  });
  assert.equal(parseSmtpUrl('smtps://mail.example.test').port, 465);
  assert.equal(parseSmtpUrl('smtps://mail.example.test').secure, true);
  assert.throws(() => parseSmtpUrl('http://mail.example.test'), /must start with smtp:\/\/ or smtps:\/\//);
  assert.throws(() => parseSmtpUrl('smtp://'), /no host/);
});
