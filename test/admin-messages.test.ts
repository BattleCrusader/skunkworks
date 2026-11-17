/**
 * Managing messages: many at once, and a count you can reach from anywhere.
 *
 * The screen a package's table got before this was the generic property sheet — six raw columns,
 * oldest first, one `edit` link per row — which is a viewer, not a manager. What an operator does
 * with enquiries is: see how many are unhandled, open the new ones, reply, and get the handled
 * ones out of the way. None of that was reachable, and the count did not exist anywhere.
 *
 * These witnesses are written against promises that survive a redesign:
 *
 *   M1  the list is the operator's list: labels from the manifest, newest first, a badge per state;
 *   M2  the chips filter, and a chip's number is a number about the question it asks;
 *   M3  a message containing `%` is a message, not a wildcard;
 *   M4  a bulk action reaches every ticked row and leaves one audit row per row;
 *   M5  delete is two steps and the first one writes nothing;
 *   M6  the bulk door is a write: no CSRF, no origin, no change;
 *   M7  an action the package did not declare is refused, not coerced;
 *   M8  ids are ids: junk is dropped, an empty selection says so instead of silently doing nothing;
 *   M9  the badge counts what nobody has handled, and is on every admin page;
 *   M10 thirty messages are two readable pages, not one unreadable scroll.
 *
 * No stubs: `skwctl plugin install` on the real package, the real app over a socket, and the real
 * session + CSRF token.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { packageRootHash } from '../app/plugins/manifest.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { ADMIN_HOST, ADMIN_ORIGIN, TOTP_SECRET, openSession, seedUser, type Sessioned } from './helpers/admin.ts';
import { REPO, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, header, type Res } from './helpers/http.ts';

const CLI = join(REPO, 'app', 'cli', 'skwctl.ts');
const CONTACT = join(REPO, 'plugins', 'contact');
const RUNNER_DIGEST = 'sha256:admin-messages';
const LIST = '/admin/t/acme/messages';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let session: Sessioned;

function skwctl(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    env: { ...process.env, SKW_DATA_DIR: fixture.dir },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** The packager's report, bound to the package's own bytes (§8.5). */
function reportFor(dir: string): string {
  const root = packageRootHash(dir).root;
  const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as { id: string; version: string };
  const out = join(fixture.dir, 'reports', `${root.slice(0, 10)}.json`);
  mkdirSync(join(fixture.dir, 'reports'), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify({
      plugin: manifest.id,
      version: manifest.version,
      root_hash: root,
      runner_image_digest: RUNNER_DIGEST,
      ran_at: '2026-11-17T00:00:00.000Z',
      passed: 1,
      failed: 0,
    }),
  );
  return out;
}

/** How many filter chips claim to be the current view. */
function countCurrentChips(body: string): number {
  return (body.match(/class="msg-chip[^"]*"[^>]*aria-current="true"/g) ?? []).length;
}

function get(path: string): Promise<Res> {
  return call({ port, path, host: ADMIN_HOST, headers: { cookie: session.cookie } });
}

type Fields = Record<string, string | string[]>;

function post(path: string, fields: Fields, opts: { csrf?: boolean; origin?: boolean } = {}): Promise<Res> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    for (const one of Array.isArray(v) ? v : [v]) params.append(k, one); // repeated names = an array
  }
  if (opts.csrf !== false) params.set('csrf', session.csrfToken);
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    cookie: session.cookie,
  };
  if (opts.origin !== false) headers.origin = ADMIN_ORIGIN;
  return call({ port, path, method: 'POST', host: ADMIN_HOST, headers, body: params.toString() });
}

/** A message, inserted the way the endpoint inserts one. */
function addMessage(n: number, opts: { status?: string; name?: string; message?: string; at?: string } = {}): number {
  const db = new Database(fixture.sitePath('acme'));
  try {
    const at = opts.at ?? new Date(Date.UTC(2026, 10, 17, 9, n)).toISOString();
    const row = db
      .prepare(
        `INSERT INTO p_contact_message (name, email, company, message, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opts.name ?? `Person ${n}`,
        `person${n}@example.test`,
        n % 2 === 0 ? `Firm ${n}` : null,
        opts.message ?? `Question number ${n} about a quote.`,
        opts.status ?? 'new',
        at,
      );
    return Number(row.lastInsertRowid);
  } finally {
    db.close();
  }
}

/** Every message's status, by id. */
function statuses(): Map<number, string> {
  const db = new Database(fixture.sitePath('acme'), { readonly: true });
  try {
    const rows = db.prepare('SELECT id, status FROM p_contact_message').all() as { id: number; status: string }[];
    return new Map(rows.map((r) => [r.id, r.status]));
  } finally {
    db.close();
  }
}

/** How many audit rows name this table, by action verb. */
function auditCount(verb: string): number {
  const db = new Database(fixture.sitePath('acme'), { readonly: true });
  try {
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM cms_audit WHERE target_kind = ? AND action = ?')
      .get('p_contact_message', `p_contact_message.${verb}`) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: [ADMIN_HOST], title: 'Acme' }] });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'owner@acme.test', totpSecret: TOTP_SECRET });

  const installed = skwctl(['plugin', 'install', CONTACT, '--tenant', 'acme', '--allow-unsigned', '--test-report', reportFor(CONTACT), '--runner-digest', RUNNER_DIGEST, '--enable']);
  assert.equal(installed.status, 0, `install failed: ${installed.stderr}${installed.stdout}`);

  handle = await buildApp({ env: loadEnv(fixture.env) });
  port = await handle.app
    .listen({ port: 0, host: '127.0.0.1' })
    .then(() => (handle.app.server.address() as { port: number }).port);
  session = await openSession({ port, key: 'acme', email: 'owner@acme.test' });
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

test('M1. the list is the operator’s list: manifest labels, newest first, a badge per state', async () => {
  const old = addMessage(1, { name: 'Older Person', status: 'replied', at: '2026-11-01T08:00:00.000Z' });
  const recent = addMessage(2, { name: 'Newer Person', status: 'new', at: '2026-11-16T08:00:00.000Z' });
  const res = await get(LIST);
  assert.equal(res.status, 200, res.body);
  void old;
  void recent;

  // The labels are the package's words, not the columns'.
  for (const label of ['From', 'Reply to', 'Handling', 'Message', 'When']) {
    assert.match(res.body, new RegExp(`>\\s*${label}\\s*<`), `the list must be headed ${label}`);
  }
  // Newest first — the property sheet ordered by primary key, which is arrival order.
  assert.ok(
    res.body.indexOf('Newer Person') < res.body.indexOf('Older Person'),
    'the newest message must come first',
  );
  // The state is a word with a badge, and the row carries a checkbox that names its own id.
  assert.match(res.body, /class="msg-badge msg-badge--new">new</);
  assert.match(res.body, /name="ids" value="\d+"/);
  // A reply is one press away.
  assert.match(res.body, /href="mailto:person2@example\.test"/);
  // Every bulk door is present, in the package's own vocabulary, plus the destructive one.
  for (const value of ['new', 'read', 'replied', 'archived']) {
    assert.match(res.body, new RegExp(`name="action" value="${value}"`), `no bulk button for ${value}`);
  }
  assert.match(res.body, /name="action" value="delete"/);
  // …and the words on them are the package's, not the base's.
  assert.match(res.body, />Mark read</);
  assert.match(res.body, />Archive</);
  // And the card is padded, like every card on this surface.
  assert.match(res.body, /class="card card--padded"/);
});

test('M2. a chip filters, and its number is a number about the question it asks', async () => {
  const all = await get(LIST);
  const onlyNew = await get(`${LIST}?status=new`);
  assert.equal(onlyNew.status, 200, onlyNew.body);

  const newCount = (statuses().values ? [...statuses().values()].filter((s) => s === 'new').length : 0);
  // The chip for `new` carries that count as its own number.
  assert.match(onlyNew.body, new RegExp(`>new\\s*<b>${newCount}</b>|>new\\s*<b[^>]*>${newCount}</b>`));

  // The filtered view shows the new ones and not the replied one.
  assert.match(onlyNew.body, /Newer Person/);
  assert.doesNotMatch(onlyNew.body, /Older Person/);
  // All shows both, and the "All messages" chip is the one that is current.
  assert.match(all.body, /Older Person/);
  const allChip = /<a class="msg-chip[^"]*"[^>]*aria-current="true"[^>]*>All\s/.exec(all.body);
  assert.ok(allChip !== null, 'on the unfiltered view the All chip must be current');
  assert.equal(countCurrentChips(all.body), 1, 'exactly one chip is current');
  // A status the package never declared is not a filter — it is a URL that asked nothing.
  const bogus = await get(`${LIST}?status=bogus`);
  assert.equal(bogus.status, 200);
  assert.match(bogus.body, /Older Person/, 'an undeclared status must not narrow the list');
});

test('M3. `%` in a message is a message, and `%` as a search is not a wildcard', async () => {
  addMessage(20, { name: 'Percent Person', message: 'Our budget grew 40% this year and 100% of it is committed.' });
  addMessage(21, { name: 'Plain Person', message: 'Nothing special here.' });

  const pct = await get(`${LIST}?q=40%25`);
  assert.equal(pct.status, 200, pct.body);
  assert.match(pct.body, /Percent Person/);
  assert.doesNotMatch(pct.body, /Plain Person/);

  // A bare `%` would match every row under LIKE. It must match only rows containing a `%`.
  const bare = await get(`${LIST}?q=%25`);
  assert.equal(bare.status, 200, bare.body);
  assert.match(bare.body, /Percent Person/);
  assert.doesNotMatch(bare.body, /Plain Person/, 'a bare % must not match everything');

  // `_` is a character too: `_` alone must not match every one-character position.
  const underscore = await get(`${LIST}?q=_`);
  assert.doesNotMatch(underscore.body, /Plain Person/, 'a bare _ must not match everything');
});

test('M4. a bulk action reaches every ticked row, and every row keeps its own audit entry', async () => {
  const a = addMessage(31, { name: 'Bulk A' });
  const b = addMessage(32, { name: 'Bulk B' });
  const c = addMessage(33, { name: 'Bulk C' });
  const before = auditCount('update');

  const res = await post(`${LIST}/bulk`, { ids: [String(a), String(b), String(c)], action: 'read' });
  assert.equal(res.status, 303, res.body);
  const location = header(res, 'location');
  assert.ok(location !== undefined);
  assert.match(location, /done=ran/);
  assert.match(location, /action=read/);
  assert.match(location, /n=3/);

  const after = statuses();
  for (const id of [a, b, c]) assert.equal(after.get(id), 'read', `message ${id} was not marked read`);
  assert.equal(auditCount('update') - before, 3, 'one audit row per message, or the change is unattributable');
});

test('M5. delete is two steps, and the first one writes nothing', async () => {
  const keep = addMessage(41, { name: 'Keep Me' });
  const gone1 = addMessage(42, { name: 'Delete One' });
  const gone2 = addMessage(43, { name: 'Delete Two' });
  const auditedBefore = auditCount('delete');
  const sizeBefore = statuses().size;

  const step = await post(`${LIST}/bulk`, { ids: [String(gone1), String(gone2)], action: 'delete' });
  assert.equal(step.status, 200, step.body);
  // The heading is the package's own action label, and the warning is its own sentence.
  assert.match(step.body, /<h1>Delete…<\/h1>/);
  assert.match(step.body, /Deleting a message is permanent/);
  assert.match(step.body, /name="confirm" value="1"/);
  assert.match(step.body, /Delete One/);
  // Nothing has gone yet.
  assert.equal(statuses().size, sizeBefore, 'the confirmation step must not delete anything');
  assert.equal(auditCount('delete'), auditedBefore);

  const done = await post(`${LIST}/bulk`, {
    ids: [String(gone1), String(gone2)],
    action: 'delete',
    confirm: '1',
  });
  assert.equal(done.status, 303, done.body);
  assert.match(String(header(done, 'location')), /done=ran/);
  const left = statuses();
  assert.equal(left.has(gone1), false);
  assert.equal(left.has(gone2), false);
  assert.equal(left.has(keep), true, 'a delete must touch only the messages that were ticked');
  assert.equal(auditCount('delete') - auditedBefore, 2);
});

test('M6. the bulk door is a write door: no CSRF or no matching origin changes nothing', async () => {
  const id = addMessage(51, { name: 'Guarded Person' });
  const before = statuses().get(id);

  const noCsrf = await post(`${LIST}/bulk`, { ids: [String(id)], action: 'archived' }, { csrf: false });
  assert.equal(noCsrf.status, 403, noCsrf.body);

  const noOrigin = await post(`${LIST}/bulk`, { ids: [String(id)], action: 'archived' }, { origin: false });
  assert.equal(noOrigin.status, 403, noOrigin.body);

  assert.equal(statuses().get(id), before, 'a refused request must not have written');
});

test('M7. an action the package did not declare is refused, not coerced', async () => {
  const id = addMessage(61, { name: 'Status Holder' });
  const res = await post(`${LIST}/bulk`, { ids: [String(id)], action: 'sold' });
  assert.equal(res.status, 400, res.body);
  assert.equal(statuses().get(id), 'new', 'an unknown action must leave the row alone');
});

test('M8. ids are ids: junk is dropped, and an empty selection says so', async () => {
  const id = addMessage(71, { name: 'Numeric Only' });
  const res = await post(`${LIST}/bulk`, {
    ids: ['0; DROP TABLE p_contact_message', 'abc', String(id)],
    action: 'read',
  });
  assert.equal(res.status, 303, res.body);
  assert.match(String(header(res, 'location')), /n=1/);
  assert.equal(statuses().get(id), 'read', 'the one real id must still be applied');

  const empty = await post(`${LIST}/bulk`, { action: 'read' });
  assert.equal(empty.status, 303);
  assert.match(String(header(empty, 'location')), /done=nothing/);
});

test('M9. the unhandled count is on every admin page, and it goes to the screen', async () => {
  // Put every message in one state so the number is a fact this test set, not a leftover.
  const db = new Database(fixture.sitePath('acme'));
  try {
    db.prepare("UPDATE p_contact_message SET status = 'new'").run();
  } finally {
    db.close();
  }
  const unhandled = statuses().size;
  const pages = await get('/admin/t/acme/');
  assert.equal(pages.status, 200, pages.body);
  assert.match(pages.body, /class="inboxpill"/, 'the inbox pill must be in the app bar');
  assert.match(pages.body, /href="\/admin\/t\/acme\/messages"/);
  assert.match(pages.body, new RegExp(`Inbox ${unhandled}\\b`), `the pill must read Inbox ${unhandled}`);

  // Zero unhandled still draws the pill — an inbox you can only reach when it is full is useless.
  const open = [...statuses().entries()].filter(([, s]) => s === 'new').map(([id]) => String(id));
  if (open.length > 0) {
    const marked = await post(`${LIST}/bulk`, { ids: open, action: 'replied' });
    assert.equal(marked.status, 303);
  }
  const empty = await get('/admin/t/acme/');
  assert.match(empty.body, /class="inboxpill"/, 'the pill must survive being empty');
  assert.doesNotMatch(empty.body, /Inbox \d/, 'with nothing unhandled the pill reads Inbox, not Inbox 0');
});

/**
 * A quiet visit stays quiet.
 *
 * The flash is read off the redirect's query (`?done=ran&action=read&n=3`), and `queryValue` answers
 * `undefined` for a parameter that is not there. Testing for `null` instead meant the guard never
 * fired: every plain visit to the screen rendered a flash reading "0 rows changed." — a status
 * message about an action nobody took.
 */
test('M9b. a plain visit renders no status message, and one with an outcome says what happened', async () => {
  const plain = await get(LIST);
  assert.equal(plain.status, 200, plain.body);
  assert.doesNotMatch(plain.body, /rows changed/, 'a visit that changed nothing must not report a change');
  assert.doesNotMatch(plain.body, /class="acct__flash/, 'no flash element at all without an outcome');

  const reported = await get(`${LIST}?done=ran&action=read&n=2`);
  assert.match(reported.body, /class="acct__flash/);
  assert.match(reported.body, /Mark read: 2 rows\./);

  const nothing = await get(`${LIST}?done=nothing`);
  assert.match(nothing.body, /Nothing was selected/);
});

test('M10. thirty messages are two readable pages, not one unreadable scroll', async () => {
  // Bring the table to a known 30 rows, all in one state, then read both pages.
  const db = new Database(fixture.sitePath('acme'));
  try {
    db.prepare("DELETE FROM p_contact_message WHERE name LIKE 'Page %'").run();
    const insert = db.prepare(
      `INSERT INTO p_contact_message (name, email, message, status, created_at) VALUES (?, ?, ?, 'new', ?)`,
    );
    for (let i = 0; i < 30; i += 1) {
      insert.run(`Page ${i}`, `page${i}@example.test`, `Body ${i}`, new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString());
    }
  } finally {
    db.close();
  }

  const first = await get(`${LIST}?q=Page&page=1`);
  assert.equal(first.status, 200, first.body);
  assert.match(first.body, /of 30 rows/);
  assert.match(first.body, /1–25 of 30/);
  assert.match(first.body, /rel="next"/);
  assert.doesNotMatch(first.body, /rel="prev"/);

  const second = await get(`${LIST}?q=Page&page=2`);
  assert.equal(second.status, 200, second.body);
  assert.match(second.body, /26–30 of 30/);
  assert.match(second.body, /rel="prev"/);

  // A page beyond the end clamps to the last page rather than answering an empty table.
  const beyond = await get(`${LIST}?q=Page&page=99`);
  assert.match(beyond.body, /26–30 of 30/);
});
