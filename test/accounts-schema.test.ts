/**
 * The board's tables, and the constraints that are the security model.
 *
 * Each assertion below is a rule that would otherwise have to be remembered in a handler. They are
 * CHECKs and UNIQUEs on purpose: a handler can be forgotten, a constraint cannot be bypassed by the
 * next route somebody adds.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { SCHEMA } from '../test/helpers/fixture.ts';

function db(): Database.Database {
  const handle = new Database(':memory:');
  handle.exec(readFileSync(join(SCHEMA, 'site.sql'), 'utf8'));
  return handle;
}

const PASSWORD = `$argon2id$v=19$m=19456,t=2,p=1$JN5EPdyYsCT1SfDh6NEi+Q$enBpf75OKqRG2oStu3bad9DZgnlmWylWvDyrkQZGZjw`;

function account(handle: Database.Database, over: Record<string, unknown> = {}): number {
  const row = {
    email: 'sam@example.test',
    password_hash: PASSWORD,
    totp_secret: 'JBSWY3DPEHPK3PXP',
    ...over,
  };
  const info = handle
    .prepare('INSERT INTO cms_account (email, password_hash, totp_secret) VALUES (@email, @password_hash, @totp_secret)')
    .run(row);
  return Number(info.lastInsertRowid);
}

test('S9-1 — an active account cannot exist without a verified address', () => {
  const handle = db();
  try {
    const id = account(handle);
    assert.throws(
      () => handle.prepare("UPDATE cms_account SET status = 'active' WHERE id = ?").run(id),
      /CHECK constraint failed/,
      'activation without a verified email must be unrepresentable',
    );
    handle.prepare("UPDATE cms_account SET email_verified = 1 WHERE id = ?").run(id);
    assert.throws(
      () => handle.prepare("UPDATE cms_account SET status = 'active' WHERE id = ?").run(id),
      /CHECK constraint failed/,
      'activation without a confirmed OTP must be unrepresentable',
    );
    handle
      .prepare("UPDATE cms_account SET totp_confirmed_at = '2026-10-27T00:00:00.000Z', status = 'active' WHERE id = ?")
      .run(id);
    assert.equal(
      (handle.prepare('SELECT status FROM cms_account WHERE id = ?').get(id) as { status: string }).status,
      'active',
    );
  } finally {
    handle.close();
  }
});

test('S9-2 — a second account cannot take an address, in any case', () => {
  const handle = db();
  try {
    account(handle, { email: 'sam@example.test' });
    assert.throws(() => account(handle, { email: 'SAM@Example.TEST' }), /UNIQUE constraint failed/);
  } finally {
    handle.close();
  }
});

test('S9-3 — the role vocabulary is closed, and a duplicate grant is refused', () => {
  const handle = db();
  try {
    const id = account(handle);
    handle.prepare("INSERT INTO cms_account_role (account_id, role) VALUES (?, 'applicant')").run(id);
    handle.prepare("INSERT INTO cms_account_role (account_id, role) VALUES (?, 'advertiser')").run(id);
    assert.throws(
      () => handle.prepare("INSERT INTO cms_account_role (account_id, role) VALUES (?, 'admin')").run(id),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => handle.prepare("INSERT INTO cms_account_role (account_id, role) VALUES (?, 'applicant')").run(id),
      /UNIQUE constraint failed|PRIMARY KEY/,
    );
  } finally {
    handle.close();
  }
});

test('S9-4 — a verification token is single-use by construction, and its plaintext is not stored', () => {
  const handle = db();
  try {
    const id = account(handle);
    const hash = 'ab'.repeat(32);
    handle
      .prepare(
        "INSERT INTO cms_account_token (account_id, purpose, token_hash, expires_at, ip_hash, created_at) VALUES (?, 'verify_email', ?, '2026-10-28T00:00:00.000Z', ?, '2026-10-27T00:00:00.000Z')",
      )
      .run(id, hash, 'cd'.repeat(32));
    // The consumption is a conditional UPDATE: the first caller wins, the second changes nothing.
    // `consumed_at >= created_at` is itself a CHECK, so the test consumes at a time that could
    // really have happened rather than at "now", which would be before this row was created.
    const consume = handle.prepare(
      "UPDATE cms_account_token SET consumed_at = '2026-10-27T00:05:00.000Z' WHERE token_hash = ? AND consumed_at IS NULL",
    );
    assert.equal(consume.run(hash).changes, 1);
    assert.equal(consume.run(hash).changes, 0, 'a consumed token must not be consumable again');
    assert.throws(
      () =>
        handle
          .prepare(
            "INSERT INTO cms_account_token (account_id, purpose, token_hash, expires_at, ip_hash) VALUES (?, 'verify_email', ?, '2026-10-28T00:00:00.000Z', ?)",
          )
          .run(id, hash, 'cd'.repeat(32)),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () =>
        handle
          .prepare(
            "INSERT INTO cms_account_token (account_id, purpose, token_hash, expires_at, ip_hash) VALUES (?, 'login_by_magic', ?, '2026-10-28T00:00:00.000Z', ?)",
          )
          .run(id, 'ef'.repeat(32), 'cd'.repeat(32)),
      /CHECK constraint failed/,
    );
  } finally {
    handle.close();
  }
});

test('S9-5 — a profile is hidden and does not subscribe to mail unless the person says so', () => {
  const handle = db();
  try {
    const id = account(handle);
    handle.prepare("INSERT INTO cms_profile (account_id, display_name) VALUES (?, 'Sam')").run(id);
    const row = handle
      .prepare('SELECT visibility, notify_new_jobs, work_mode, hourly_rate_cents, currency FROM cms_profile WHERE account_id = ?')
      .get(id) as {
      visibility: string;
      notify_new_jobs: number;
      work_mode: string;
      hourly_rate_cents: number | null;
      currency: string;
    };
    assert.equal(row.visibility, 'hidden', 'a new profile is not discoverable');
    assert.equal(row.notify_new_jobs, 0, 'a new profile is not subscribed to job mail');
    assert.equal(row.work_mode, 'onsite', 'a new profile is on-site until the person says otherwise');
    assert.equal(row.hourly_rate_cents, null, 'a new profile has no rate: "discussed" is the default');
    assert.equal(row.currency, 'AUD');
    assert.throws(
      () => handle.prepare("UPDATE cms_profile SET visibility = 'public' WHERE account_id = ?").run(id),
      /CHECK constraint failed/,
      'the visibility vocabulary is closed',
    );
    assert.throws(
      () => handle.prepare("UPDATE cms_profile SET notify_new_jobs = 2 WHERE account_id = ?").run(id),
      /CHECK constraint failed/,
    );
    // v10: the work arrangement is a closed three-word vocabulary, and the rate has a ceiling.
    assert.throws(
      () => handle.prepare("UPDATE cms_profile SET work_mode = 'sometimes' WHERE account_id = ?").run(id),
      /CHECK constraint failed/,
      'the work-mode vocabulary is closed',
    );
    assert.throws(
      () => handle.prepare('UPDATE cms_profile SET hourly_rate_cents = 500001 WHERE account_id = ?').run(id),
      /CHECK constraint failed/,
      'past $5,000 an hour the value is a typo, and the column refuses it',
    );
    assert.throws(
      () => handle.prepare('UPDATE cms_profile SET hourly_rate_cents = 0 WHERE account_id = ?').run(id),
      /CHECK constraint failed/,
    );
  } finally {
    handle.close();
  }
});

test('S9-6 — the profile table has no column that could hold an address', () => {
  const handle = db();
  try {
    const columns = (handle.pragma('table_info(cms_profile)') as { name: string }[]).map((c) => c.name);
    for (const forbidden of ['email', 'phone', 'address', 'contact', 'mobile', 'postcode']) {
      assert.equal(columns.includes(forbidden), false, `cms_profile must not have a ${forbidden} column`);
    }
  } finally {
    handle.close();
  }
});

test('S9-7 — one outbox row is one recipient, and an idempotency key cannot send twice', () => {
  const handle = db();
  try {
    const insert = handle.prepare(
      "INSERT INTO cms_mail (to_email, template, subject, vars_json, idempotency_key) VALUES (?, 'job.match', 'New fractional role', '{}', ?)",
    );
    insert.run('a@example.test', 'job:12:account:41');
    assert.throws(() => insert.run('a@example.test', 'job:12:account:41'), /UNIQUE constraint failed/);
    assert.equal(
      (handle.prepare("SELECT status, attempts FROM cms_mail WHERE to_email = 'a@example.test'").get() as {
        status: string;
        attempts: number;
      }).status,
      'queued',
    );
    assert.throws(
      () =>
        handle
          .prepare(
            "INSERT INTO cms_mail (to_email, template, subject, vars_json, idempotency_key) VALUES ('b@example.test','t','s','{}','k2')",
          )
          .run(),
      /CHECK constraint failed/,
      'a template name is required',
    );
  } finally {
    handle.close();
  }
});

test('S9-8 — a suppression is case-insensitive, so an unsubscribe cannot be dodged by capitalisation', () => {
  const handle = db();
  try {
    handle.prepare("INSERT INTO cms_mail_suppression (email, reason) VALUES ('sam@example.test', 'unsubscribe')").run();
    assert.throws(
      () => handle.prepare("INSERT INTO cms_mail_suppression (email, reason) VALUES ('SAM@Example.Test', 'manual')").run(),
      /UNIQUE constraint failed|PRIMARY KEY/,
    );
    assert.throws(
      () => handle.prepare("INSERT INTO cms_mail_suppression (email, reason) VALUES ('x@example.test', 'bored')").run(),
      /CHECK constraint failed/,
    );
  } finally {
    handle.close();
  }
});

test('S9-9 — deleting an account takes its sessions, tokens, roles and profile with it', () => {
  const handle = db();
  try {
    handle.pragma('foreign_keys = ON');
    const id = account(handle);
    handle.prepare("INSERT INTO cms_account_role (account_id, role) VALUES (?, 'applicant')").run(id);
    handle.prepare("INSERT INTO cms_profile (account_id, display_name) VALUES (?, 'Sam')").run(id);
    handle
      .prepare(
        "INSERT INTO cms_account_token (account_id, purpose, token_hash, expires_at, ip_hash) VALUES (?, 'verify_email', ?, '2026-10-28T00:00:00.000Z', ?)",
      )
      .run(id, 'aa'.repeat(32), 'bb'.repeat(32));
    handle
      .prepare(
        "INSERT INTO cms_account_session (id, account_id, csrf_secret, ip_hash, ua_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, '2026-10-27T00:00:00.000Z','2026-10-27T00:00:00.000Z','2026-10-27T01:00:00.000Z')",
      )
      .run('cc'.repeat(32), id, 'dd'.repeat(32), 'ee'.repeat(32), 'ff'.repeat(32));
    handle.prepare('DELETE FROM cms_account WHERE id = ?').run(id);
    for (const table of ['cms_account_role', 'cms_profile', 'cms_account_token', 'cms_account_session']) {
      const count = (handle.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
      assert.equal(count, 0, `${table} must follow the account`);
    }
  } finally {
    handle.close();
  }
});
