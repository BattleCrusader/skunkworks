/**
 * IndexNow: the key file, the submission a publish makes, and the one property that ties them
 * together — a submission carries exactly what `/sitemap.xml` lists.
 *
 * The protocol is two halves and this gate tests both, because either half alone is silently
 * useless: a key nobody fetches disables every submission, and a submission for a URL the key's
 * own sitemap does not list teaches the engine to distrust the site.
 *
 *   IN-1  `GET /<key>.txt` on the tenant's own host answers the derived key; a wrong key, another
 *         host's key and an unshaped `.txt` are 404, and `/sitemap.xml`, `/robots.txt` and a page
 *         still resolve (the parametric route does not shadow them)
 *   IN-2  a publish produces exactly one POST to `api.indexnow.org`, carrying host/key/keyLocation
 *         and exactly the published URL — and the publish response is unchanged by it
 *   IN-3  deleting a listed page submits the URL that left the sitemap
 *   IN-4  `SKW_INDEXNOW=off` produces no POST, the publish still answers `{ok:true}`, and the key
 *         route still answers 200
 *   IN-5  an engine that 500s (or whose socket fails) does not fail the publish, and the outcome is
 *         logged — fire-and-forget means the request path cannot see it
 *   IN-6  the submitter's URL set is the sitemap's URL set, asserted as an equality of the two
 *         collections rather than a hand-written expectation, so the two cannot drift
 *
 * Every outbound call is stubbed (`globalThis.fetch`): no test in this file touches the network.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { openAdminWrite, openRenderRead } from '../app/db/classes.ts';
import { loadEnv } from '../app/env.ts';
import { indexNowKey, INDEXNOW_ENDPOINT } from '../app/indexnow/indexnow.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { collectSitemapEntries } from '../app/render/sitemap.ts';
import { pageRowListed } from '../app/render/sitemap.ts';
import { ADMIN_ORIGIN, TOTP_SECRET, openSession, seedUser, type Sessioned } from './helpers/admin.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, type Res } from './helpers/http.ts';

const TENANT = 'acme';
const HOST = 'acme.test';
const OWNER = 'publish@acme.test';
const SECRET = 'test-session-key-0123456789abcdef';

let fixture: Fixture;
let handle: AppHandle;
let offHandle: AppHandle;
let port = 0;
let offPort = 0;
let session: Sessioned;
const logs: string[] = [];

interface Sent {
  url: string;
  method: string;
  body: unknown;
}

/** The stub: records each call and answers `status`. `globalThis.fetch` is restored in `after`. */
let sent: Sent[] = [];
let answer: (() => Promise<Response>) | null = null;
const realFetch = globalThis.fetch;

function stubFetch(status = 200): void {
  sent = [];
  answer = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    if (answer !== null) return answer();
    return new Response('', { status });
  }) as typeof fetch;
}

function write(query: (db: ReturnType<typeof openAdminWrite>) => void): void {
  const db = openAdminWrite(fixture.sitePath(TENANT), 5000);
  try {
    query(db);
  } finally {
    db.close();
  }
}

function read<T>(query: (db: ReturnType<typeof openAdminWrite>) => T): T {
  const db = openAdminWrite(fixture.sitePath(TENANT), 5000);
  try {
    return query(db);
  } finally {
    db.close();
  }
}

function pageId(path: string): number {
  return read((db) => (db.prepare('SELECT id FROM cms_page WHERE path = ?').get(path) as { id: number }).id);
}

/** A draft with something to publish, at a path only this file uses. */
function seedDraft(path: string, robots?: 'noindex'): number {
  const slug = path.replace(/^\//, '').replace(/[^a-z0-9-]/g, '-');
  write((db) => {
    db.prepare(
      `INSERT INTO cms_page
         (path, slug, title, status, template, body_html, body_css, rev, body_sha,
          draft_html, draft_css, draft_sha, seo_json, managed_by)
       VALUES (?, ?, ?, 'draft', 'page', '', '', 0, '', ?, '', ?, ?, 'editor')`,
    ).run(path, slug, `Draft ${slug}`, `<h1>${slug}</h1>`, 'ab'.repeat(32), robots === undefined ? null : JSON.stringify({ robots }));
  });
  return pageId(path);
}

async function get(path: string, onPort = port, host = HOST): Promise<Res> {
  return call({ port: onPort, path, host });
}

async function publish(id: number, onPort = port): Promise<Res> {
  return call({
    port: onPort,
    path: `/admin/t/${TENANT}/editor/publish`,
    method: 'POST',
    host: HOST,
    headers: { origin: ADMIN_ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie },
    body: new URLSearchParams({ csrf: session.csrfToken, id: String(id) }).toString(),
  });
}

function locsOf(body: string): string[] {
  return [...body.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => (m[1] as string).replace(/&amp;/g, '&'));
}

before(async () => {
  fixture = makeFixture({
    specs: [{ key: TENANT, hosts: [HOST], title: 'Acme', body: '<h1>Fractional engineering</h1>', status: 'active' }],
  });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: TENANT, email: OWNER, totpSecret: TOTP_SECRET });
  handle = await buildApp({
    env: loadEnv({ ...fixture.env, SKW_INDEXNOW: 'on' }),
    indexNowLog: (line) => logs.push(line),
  });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
  session = await openSession({ port, key: TENANT, email: OWNER });

  // A second process-level surface with the switch off: same data, same session key, same control
  // db, so the cookie the first one issued is the credential here too.
  offHandle = await buildApp({
    env: loadEnv({ ...fixture.env, SKW_INDEXNOW: 'off' }),
    indexNowLog: (line) => logs.push(`off: ${line}`),
  });
  await offHandle.app.listen({ port: 0, host: '127.0.0.1' });
  const offAddress = offHandle.app.server.address();
  offPort = typeof offAddress === 'object' && offAddress !== null ? offAddress.port : 0;
});

after(async () => {
  globalThis.fetch = realFetch;
  if (offHandle !== undefined) await offHandle.close();
  if (handle !== undefined) await handle.close();
  if (fixture !== undefined) fixture.cleanup();
});

// --- IN-1: the key file ----------------------------------------------------

test('IN-1. the tenant host serves its own derived key, and nothing else answers', async () => {
  const key = indexNowKey(SECRET, HOST);
  assert.match(key, /^[0-9a-f]{32}$/, 'the key is 32 lowercase hex characters');

  const res = await get(`/${key}.txt`);
  assert.equal(res.status, 200, res.body);
  assert.match(String(res.headers['content-type']), /^text\/plain/);
  assert.equal(res.body, key, 'the body is the key itself');
  assert.equal(res.headers['cache-control'], 'public, max-age=86400');

  // A key-shaped path that is not this host's key: a stranger's guess, another tenant's key, and a
  // suffix the route does not match. All three are the tenant's ordinary 404.
  const wrong = await get(`/${'0'.repeat(32)}.txt`);
  assert.equal(wrong.status, 404, wrong.body);
  const otherHost = await get(`/${indexNowKey(SECRET, 'beta.test')}.txt`);
  assert.equal(otherHost.status, 404, 'a key derived for another host is not this host\'s key');
  const deeper = await get(`/${key}/extra.txt`);
  assert.equal(deeper.status, 404, 'only a single-segment .txt is a key path');

  // …and the parametric route did not take the static ones: the sitemap, the robots file and a page
  // are still theirs.
  assert.equal((await get('/sitemap.xml')).status, 200);
  assert.equal((await get('/robots.txt')).status, 200);
  assert.equal((await get('/pricing')).status, 200);

  // The key is public; the secret is not. Nothing the route or the submitter logs carries it.
  assert.equal(logs.some((line) => line.includes(SECRET)), false, 'the secret never reaches a log line');
});

// --- IN-2: a publish announces exactly one URL -----------------------------

test('IN-2. a publish posts exactly one IndexNow submission carrying the published URL', async () => {
  const id = seedDraft('/notes/indexnow-publish');
  stubFetch(200);
  try {
    const res = await publish(id);
    assert.equal(res.status, 200, res.body);
    assert.equal((res.json as { ok?: unknown }).ok, true);
    // The response was written before the POST finished — the submitter is fire-and-forget…
    await handle.indexNow.whenIdle();
    // …and the POST is one call with the protocol's body.
    assert.equal(sent.length, 1, `one submission, got ${sent.length}`);
    const call0 = sent[0] as Sent;
    assert.equal(call0.url, INDEXNOW_ENDPOINT);
    assert.equal(call0.method, 'POST');
    const key = indexNowKey(SECRET, HOST);
    assert.deepEqual(call0.body, {
      host: HOST,
      key,
      keyLocation: `https://${HOST}/${key}.txt`,
      urlList: [`https://${HOST}/notes/indexnow-publish`],
    });
    assert.equal(logs.some((line) => line.includes(`status=200`)), true, 'one line says what happened');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- IN-3: a deletion announces the removed URL ----------------------------

test('IN-3. deleting a listed page submits the URL that left the sitemap', async () => {
  const path = '/notes/indexnow-delete';
  const id = seedDraft(path);
  // Publish first, so the page is in the sitemap before it is removed. (This submit is IN-2's
  // business; it is drained and discarded so this test sees only the removal.)
  stubFetch(200);
  try {
    await publish(id);
    await handle.indexNow.whenIdle();
    assert.equal(sent.length, 1);

    sent = [];
    const removed = await call({
      port,
      path: `/admin/t/${TENANT}/tables/cms_page/${String(id)}/delete`,
      method: 'POST',
      host: HOST,
      headers: { origin: ADMIN_ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie },
      body: new URLSearchParams({ csrf: session.csrfToken }).toString(),
    });
    assert.equal(removed.status, 303, removed.body.slice(0, 300));
    await handle.indexNow.whenIdle();

    assert.equal(sent.length, 1, 'the delete submits once');
    const urlList = (sent[0] as Sent).body as { urlList: string[] };
    assert.deepEqual(urlList.urlList, [`https://${HOST}${path}`], 'the removed URL itself');
    assert.equal((await get('/sitemap.xml')).body.includes(`${HOST}${path}`), false, 'and it is gone from the sitemap');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- IN-4: the switch ------------------------------------------------------

test('IN-4. SKW_INDEXNOW=off sends nothing, the publish still succeeds, and the key still answers', async () => {
  const id = seedDraft('/notes/indexnow-off');
  stubFetch(200);
  try {
    const res = await publish(id, offPort);
    assert.equal(res.status, 200, res.body);
    assert.equal((res.json as { ok?: unknown }).ok, true, 'the publish is not conditional on the submission');
    await offHandle.indexNow.whenIdle();
    assert.equal(sent.length, 0, 'off means no POST');

    const key = indexNowKey(SECRET, HOST);
    const served = await get(`/${key}.txt`, offPort);
    assert.equal(served.status, 200, 'a key that 404s is worse than no ping');
    assert.equal(served.body, key);

    // The ON handle shares this tenant's sitemap, so the page the OFF process published is public.
    assert.match((await get('/sitemap.xml')).body, /notes\/indexnow-off/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- IN-5: a failing engine cannot fail a publish ---------------------------

test('IN-5. a 500 or a dead socket does not fail the publish, and the outcome is logged', async () => {
  stubFetch(200);
  try {
    answer = async () => new Response('rejected', { status: 500 });
    const first = seedDraft('/notes/indexnow-failing');
    const res = await publish(first);
    assert.equal(res.status, 200, 'the publish answered before the engine was heard from');
    await handle.indexNow.whenIdle();
    assert.equal(sent.length, 1);
    assert.equal(logs.at(-1)?.includes('failed'), true, `a failure is one log line, got ${String(logs.at(-1))}`);

    // A socket that fails outright is the same outcome: logged, never thrown.
    sent = [];
    answer = async () => {
      throw new Error('ECONNREFUSED');
    };
    const second = seedDraft('/notes/indexnow-unreachable');
    const again = await publish(second);
    assert.equal(again.status, 200);
    assert.equal((again.json as { ok?: unknown }).ok, true);
    await handle.indexNow.whenIdle();
    assert.equal(sent.length, 1);
    assert.equal(logs.at(-1)?.includes('ECONNREFUSED') ?? false, true, `the reason is in the line, got ${String(logs.at(-1))}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- IN-6: one URL set ------------------------------------------------------

test('IN-6. the submitter\'s URL set is the sitemap\'s URL set, for the same tenant', async () => {
  stubFetch(200);
  try {
    const served = await get('/sitemap.xml');
    assert.equal(served.status, 200, served.body);
    const sitemapUrls = locsOf(served.body);

    // What a submission (and `skw-indexnow`, which submits every URL) collects. Same function the
    // route calls; same tenant, same origin, same plugin runtime. If these two ever disagree, one
    // of them is lying about what the site publishes.
    const db = openRenderRead(fixture.sitePath(TENANT), 5000);
    let submitted: string[];
    try {
      submitted = (
        await collectSitemapEntries({
          db,
          tenantKey: TENANT,
          origin: `https://${HOST}`,
          emailMode: 'off',
          plugins: handle.plugins,
        })
      ).map((entry) => entry.loc);
    } finally {
      db.close();
    }
    assert.deepEqual(submitted, sitemapUrls, 'the two enumerations are one enumeration');

    // And the set excludes what a crawler must never be invited to.
    assert.equal(submitted.some((url) => url.includes('/admin') || url.includes('/search')), false);
    assert.equal(submitted.includes(`https://${HOST}/pricing`), true, 'a published page is in both');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- the predicate itself ---------------------------------------------------

test('IN-6b. the row predicate agrees with the sitemap about drafts, schedules and hidden pages', async () => {
  const id = seedDraft('/notes/indexnow-predicate');
  const db = openAdminWrite(fixture.sitePath(TENANT), 5000);
  try {
    const row = () =>
      db.prepare('SELECT status, published_at, seo_json FROM cms_page WHERE id = ?').get(id) as {
        status: string;
        published_at: string | null;
        seo_json: string | null;
      };
    assert.equal(pageRowListed(row()), false, 'a draft is not listed');

    db.prepare("UPDATE cms_page SET status = 'published', published_at = ? WHERE id = ?").run('2026-01-01T00:00:00.000Z', id);
    assert.equal(pageRowListed(row()), true, 'published and due is listed');

    db.prepare("UPDATE cms_page SET published_at = '2999-01-01T00:00:00.000Z' WHERE id = ?").run(id);
    assert.equal(pageRowListed(row()), false, 'a future-dated page is not listed yet');

    db.prepare("UPDATE cms_page SET published_at = '2026-01-01T00:00:00.000Z', seo_json = ? WHERE id = ?").run(
      JSON.stringify({ robots: 'noindex' }),
      id,
    );
    assert.equal(pageRowListed(row()), false, 'a page hidden from search is not listed');
  } finally {
    db.close();
    write((handleDb) => handleDb.prepare('DELETE FROM cms_page WHERE id = ?').run(id));
  }
});
