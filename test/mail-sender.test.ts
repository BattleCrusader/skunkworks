/**
 * Which address a tenant's mail leaves from.
 *
 * The rule under test is small but it is the difference between a multi-site box sending honest mail
 * and one customer's enquiries leaving under another customer's domain. The rows are real: an
 * in-memory `cms_settings` shaped like the shipped one, because the failure this guards against
 * (`value_json` holding a number, or the table being absent) is a database detail, not a code one.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { test } from 'node:test';

import { MAIL_FROM_SETTING, resolveMailFrom } from '../app/mail/sender.ts';

const FALLBACK = 'default@example.test';

function settingsDb(rows: Record<string, unknown>, withTable = true): Database.Database {
  const db = new Database(':memory:');
  if (withTable) db.exec('CREATE TABLE cms_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)');
  const insert = withTable ? db.prepare('INSERT INTO cms_settings (key, value_json) VALUES (?, ?)') : null;
  for (const [key, value] of Object.entries(rows)) insert?.run(key, JSON.stringify(value));
  return db;
}

test('M1. a tenant that declares a sender sends from it, not from the deployment default', () => {
  const db = settingsDb({ [MAIL_FROM_SETTING]: 'hello@arnavia.com', 'site.footer_text': 'ignored' });
  assert.equal(resolveMailFrom(db, FALLBACK), 'hello@arnavia.com');
  db.close();
});

test('M2. a tenant that has not declared one falls back to the deployment default', () => {
  const db = settingsDb({ 'site.footer_text': 'no sender here' });
  assert.equal(resolveMailFrom(db, FALLBACK), FALLBACK);
  db.close();
});

test('M3. a stored value that is not an address is an unset answer, not a refusal to send', () => {
  for (const bad of ['', '   ', 'not-an-address', 'a@b', 'two words@example.com', 'x@y.zz'.repeat(60)]) {
    const db = settingsDb({ [MAIL_FROM_SETTING]: bad });
    assert.equal(resolveMailFrom(db, FALLBACK), FALLBACK, `expected the fallback for ${JSON.stringify(bad.slice(0, 40))}`);
    db.close();
  }
});

test('M4. a row holding a non-string (a number, an object) is an unset answer too', () => {
  for (const value of [42, 0, ['hello@arnavia.com'], { address: 'hello@arnavia.com' }, null, true]) {
    const db = settingsDb({ [MAIL_FROM_SETTING]: value });
    assert.equal(resolveMailFrom(db, FALLBACK), FALLBACK, `expected the fallback for ${JSON.stringify(value)}`);
    db.close();
  }
});

test('M5. a database with no settings table still sends: the default is the answer', () => {
  const db = settingsDb({}, false);
  assert.equal(resolveMailFrom(db, FALLBACK), FALLBACK);
  db.close();
});

test('M6. the value is trimmed, so a pasted address with a trailing newline still works', () => {
  const db = settingsDb({ [MAIL_FROM_SETTING]: '  hello@arnavia.com\n' });
  assert.equal(resolveMailFrom(db, FALLBACK), 'hello@arnavia.com');
  db.close();
});
