/**
 * The `analytics` package, driven through the real install path, the real activation path, the
 * real endpoint resolver and the real dashboard read model. Nothing here mocks the host:
 * `installPlugin()` creates the table from the validated manifest, `PluginRuntime.enable()`
 * imports the module and records what `activate(ctx)` registered, `runEndpoint()` is the function
 * the `/_plugin/*` route calls, and `readAnalytics()` is the function the operator's screen calls.
 *
 *   A1  the manifest validates: one table, one same-origin file, one POST endpoint, one hook
 *   A2  `readStaticFile()` serves the declared script and refuses everything else — a name that
 *       is not declared, a path that leaves the package, a file over the cap
 *   A3  install creates the columns and the indexes the manifest declares, and nothing more
 *   A4  enabling registers the screen, the endpoint and `page.head`, and the hook's markup is a
 *       same-origin `<script>` — the only shape the tenant CSP allows
 *   A5  the collector writes a row with the **server's** day and timestamp, derives the traffic
 *       source, and refuses an invalid payload without writing anything
 *   A6  `paused` stops the write without failing the beacon
 *   A7  the dashboard read model counts what was written, and answers `installed: false` on a
 *       tenant that has no such table
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { readAnalytics } from '../app/admin/analytics.ts';
import { openAdminWrite } from '../app/db/classes.ts';
import { runEndpoint } from '../app/plugins/endpoint.ts';
import { installPlugin } from '../app/plugins/install.ts';
import { packageRootHash, readManifest, type Manifest } from '../app/plugins/manifest.ts';
import { PluginRuntime } from '../app/plugins/runtime.ts';
import { FILE_BYTES_MAX, readStaticFile } from '../app/plugins/static.ts';
import { REPO, makeFixture, type Fixture } from './helpers/fixture.ts';

const TENANT = 'acme';
const DIGEST = 'sha256:analytics-package';
const SOURCE = join(REPO, 'plugins', 'analytics');

let fixture: Fixture;
let runtime: PluginRuntime;

function siteDbFile(): string {
  return fixture.sitePath(TENANT);
}

function read<T>(query: (db: Database.Database) => T): T {
  const db = new Database(siteDbFile(), { readonly: true });
  try {
    return query(db);
  } finally {
    db.close();
  }
}

/** The endpoint exactly as the route calls it: the tenant's db, the tenant, the host facade. */
async function collect(body: string): Promise<unknown> {
  const db = openAdminWrite(siteDbFile(), 5000);
  try {
    return await runEndpoint(runtime, {
      db,
      tenant: TENANT,
      plugin: 'analytics',
      endpoint: 'collect',
      method: 'POST',
      url: '/_plugin/analytics/collect',
      body,
    });
  } finally {
    db.close();
  }
}

function eventCount(): number {
  return read((db) => Number((db.prepare('SELECT COUNT(*) AS n FROM p_analytics_event').get() as { n: number }).n));
}

function beacon(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    k: 'pageview',
    sid: 'session-0001abcdef',
    vid: 'visitor-0001abcdef',
    p: '/pricing',
    u: 'https://acme.test/pricing',
    r: '',
    vw: 1280,
    vh: 800,
    d: 'desktop',
    b: 'Chrome',
    o: 'macOS',
    l: 'en-AU',
    ...over,
  });
}

before(async () => {
  fixture = makeFixture();
  runtime = new PluginRuntime({ dataDir: fixture.dir, emailMode: 'off' });
});

after(() => {
  runtime.closeSyncHandles();
  fixture.cleanup();
});

test('A1. the manifest declares one table, one same-origin file, one endpoint and one hook', () => {
  const manifest = readManifest(SOURCE);
  assert.equal(manifest.id, 'analytics');
  assert.deepEqual(
    manifest.tables.map((t) => t.name),
    ['p_analytics_event'],
  );
  assert.deepEqual(manifest.files, [{ name: 't.js', path: 'client/t.js', mime: 'text/javascript' }]);
  assert.deepEqual(manifest.endpoints, [{ name: 'collect', method: 'POST' }]);
  assert.deepEqual(manifest.hooks, ['page.head']);
  // The tracker needs to write and to read for retention, and nothing else.
  assert.deepEqual([...manifest.capabilities].sort(), ['log.write', 'settings.get', 'settings.has', 'store.delete', 'store.insert', 'store.query', 'util.now']);
});

test('A2. readStaticFile serves the declared script and refuses everything else', () => {
  const manifest = readManifest(SOURCE);
  const served = readStaticFile({ pluginsRoot: join(REPO, 'plugins'), plugin: 'analytics', name: 't.js', manifest });
  assert.notEqual(served, null);
  assert.equal(served?.mime, 'text/javascript');
  assert.match(String(served?.bytes), /skwa_v/);
  assert.match(String(served?.etag), /^"[0-9a-f]{32}"$/);

  // A name that is not in the manifest is not found, however real the file is.
  assert.equal(readStaticFile({ pluginsRoot: join(REPO, 'plugins'), plugin: 'analytics', name: 'index.mjs', manifest }), null);

  // A path that leaves the package is refused by realpath, not by the string check alone.
  const escaping: Manifest = {
    ...manifest,
    files: [{ name: 'x.js', path: '../../../etc/hosts', mime: 'text/javascript' }],
  };
  assert.equal(readStaticFile({ pluginsRoot: join(REPO, 'plugins'), plugin: 'analytics', name: 'x.js', manifest: escaping }), null);

  // A declared file that is not there is a 404, not a throw.
  const missing: Manifest = { ...manifest, files: [{ name: 'gone.js', path: 'client/gone.js', mime: 'text/javascript' }] };
  assert.equal(readStaticFile({ pluginsRoot: join(REPO, 'plugins'), plugin: 'analytics', name: 'gone.js', manifest: missing }), null);
  assert.ok(FILE_BYTES_MAX > (served?.bytes.length ?? 0));
});

test('A3. install creates the declared columns and indexes', () => {
  const { root } = packageRootHash(SOURCE);
  const report = join(fixture.dir, 'analytics-report.json');
  writeFileSync(
    report,
    `${JSON.stringify({ plugin: 'analytics', version: '1.0.0', root_hash: root, runner_image_digest: DIGEST, ran_at: new Date().toISOString() }, null, 2)}\n`,
  );
  installPlugin({
    siteDb: siteDbFile(),
    pluginsRoot: join(fixture.dir, 'plugins'),
    sourceDir: SOURCE,
    allowUnsigned: true,
    testReportPath: report,
    runnerImageDigest: DIGEST,
  });

  const columns = read((db) => (db.pragma('table_info(p_analytics_event)') as { name: string }[]).map((c) => c.name));
  for (const column of ['kind', 'day', 'ts', 'session', 'visitor', 'path', 'target', 'target_url', 'dwell_ms', 'device']) {
    assert.ok(columns.includes(column), `p_analytics_event is missing ${column}`);
  }
  const indexes = read((db) =>
    (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'p_analytics_event' AND sql IS NOT NULL`).all() as { name: string }[]).map((r) => r.name),
  );
  assert.deepEqual(indexes.sort(), ['ix_p_analytics_event_day', 'ix_p_analytics_event_kind', 'ix_p_analytics_event_path', 'ix_p_analytics_event_session', 'ix_p_analytics_event_visitor']);
});

test('A4. enabling registers the screen, the endpoint and page.head', async () => {
  const manifest = readManifest(SOURCE);
  const result = await runtime.enable(TENANT, 'analytics');
  assert.equal(result.alreadyActive, false);
  assert.deepEqual(result.endpoints, ['POST collect']);
  assert.deepEqual(result.hooks, ['page.head']);
  const entry = runtime.registry.get(TENANT, 'analytics');
  assert.ok(entry?.screens.has('/analytics-events'));

  // The markup the hook returns is the ONLY shape a tenant CSP allows: a same-origin file.
  const hook = entry?.hooks.get('page.head')?.[0];
  assert.equal(typeof hook, 'function');
  const markup = await hook?.({ tenant: TENANT, path: '/pricing' }, '');
  assert.equal(typeof markup, 'string');
  // Versioned, because the URL is what makes the immutable cache honest: new bytes, new URL.
  assert.equal(
    String(markup),
    `<script src="/_plugin/analytics/f/t.js?v=${manifest.version}" defer data-e="/_plugin/analytics/collect"></script>`,
  );
  // ≤ 4 KiB, which is the filter's cap (§13.3.4) — a package that overruns it is silently skipped.
  assert.ok(Buffer.byteLength(String(markup), 'utf8') < 4 * 1024);
});

test('A5. the collector stamps the server clock and derives the traffic source', async () => {
  const before = eventCount();
  const answer = await collect(beacon({ r: 'https://news.example.com/story' }));
  assert.deepEqual(answer, { ok: true });
  assert.equal(eventCount(), before + 1);

  const row = read(
    (db) =>
      db.prepare('SELECT kind, day, ts, session, visitor, path, source, medium, device FROM p_analytics_event ORDER BY id DESC LIMIT 1').get() as Record<
        string,
        unknown
      >,
  );
  assert.equal(row.kind, 'pageview');
  // The day is the server's UTC day, not anything the body said.
  assert.equal(row.day, new Date().toISOString().slice(0, 10));
  assert.match(String(row.ts), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(row.source, 'news.example.com');
  assert.equal(row.medium, 'referral');
  assert.equal(row.device, 'desktop');

  // A campaign link wins over the referrer.
  await collect(beacon({ u: 'https://acme.test/pricing?utm_source=newsletter&utm_medium=email&utm_campaign=spring' }));
  const campaign = read(
    (db) => db.prepare('SELECT source, medium, campaign FROM p_analytics_event ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>,
  );
  assert.equal(campaign.source, 'newsletter');
  assert.equal(campaign.medium, 'email');
  assert.equal(campaign.campaign, 'spring');

  // A same-site referrer is not acquisition.
  await collect(beacon({ r: 'https://acme.test/' }));
  const internal = read((db) => db.prepare('SELECT source FROM p_analytics_event ORDER BY id DESC LIMIT 1').get() as { source: string });
  assert.equal(internal.source, '(internal)');
});

test('A5b. an invalid or oversized body writes nothing', async () => {
  const before = eventCount();
  // A kind that is not one of the four.
  assert.deepEqual(await collect(beacon({ k: 'teleport' })), { ok: false, error: 'invalid', fields: ['k'] });
  // A session id too short to be one of ours.
  assert.deepEqual(await collect(beacon({ sid: 'x' })), { ok: false, error: 'invalid', fields: ['sid'] });
  // A path that is not root-relative.
  assert.deepEqual(await collect(beacon({ p: 'pricing' })), { ok: false, error: 'invalid', fields: ['p'] });
  // Not JSON at all.
  assert.deepEqual(await collect('nope'), { ok: false, error: 'body' });
  // An empty body — which is what a `Content-Type: application/json` request arrives as.
  assert.deepEqual(await collect(''), { ok: false, error: 'body' });
  // Over the package's own 4 KiB cap, under the host's 16 KiB one.
  assert.deepEqual(await collect(beacon({ t: 'x'.repeat(5000) })), { ok: false, error: 'body' });
  assert.equal(eventCount(), before);
});

test('A6. paused refuses the write without failing the beacon', async () => {
  const db = openAdminWrite(siteDbFile(), 5000);
  try {
    db.prepare(
      `INSERT INTO cms_plugin_setting (plugin_id, key, value_json, type, secret, updated_at)
       VALUES ('analytics', 'paused', 'true', 'bool', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(plugin_id, key) DO UPDATE SET value_json = excluded.value_json`,
    ).run();
  } finally {
    db.close();
  }
  const before = eventCount();
  assert.deepEqual(await collect(beacon()), { ok: true, skipped: 'paused' });
  assert.equal(eventCount(), before);

  const reset = openAdminWrite(siteDbFile(), 5000);
  try {
    reset.prepare(`UPDATE cms_plugin_setting SET value_json = 'false' WHERE plugin_id = 'analytics' AND key = 'paused'`).run();
  } finally {
    reset.close();
  }
});

test('A7. the dashboard read model counts what was written', () => {
  const db = new Database(siteDbFile(), { readonly: true });
  try {
    const report = readAnalytics(db, { days: 30, nowMs: Date.now() });
    assert.equal(report.installed, true);
    assert.equal(report.totals.pageviews, 3);
    assert.equal(report.totals.visitors, 1);
    assert.equal(report.series.length, 1);
    assert.equal(report.series[0]?.pageviews, 3);
    assert.equal(report.topPages[0]?.path, '/pricing');
    assert.equal(report.topPages[0]?.pageviews, 3);
    assert.ok(report.sources.some((s) => s.source === 'news.example.com'));
    assert.equal(report.devices[0]?.device, 'desktop');
  } finally {
    db.close();
  }

  // A tenant with no such table is `installed: false`, not nine failed queries and a 500.
  const other = new Database(fixture.sitePath('beta'), { readonly: true });
  try {
    const report = readAnalytics(other, { days: 30, nowMs: Date.now() });
    assert.equal(report.installed, false);
    assert.equal(report.totals.pageviews, 0);
    assert.deepEqual(report.series, []);
  } finally {
    other.close();
  }
});

test('A8. retention counts people, not days, and a site’s own navigation is not a source', () => {
  // Three visitors whose first day was three days ago. One came back the next day, one came back
  // two days later, one never returned. This is the shape the first implementation got wrong: it
  // counted the *set* of visitors per offset, so every day-N read "1" no matter how many returned.
  const today = new Date();
  const dayOf = (back: number): string => new Date(today.getTime() - back * 86_400_000).toISOString().slice(0, 10);
  const db = openAdminWrite(siteDbFile(), 5000);
  try {
    const insert = db.prepare(
      `INSERT INTO p_analytics_event (kind, day, ts, session, visitor, path, source, medium)
       VALUES ('pageview', ?, ?, ?, ?, '/deep', ?, ?)`,
    );
    insert.run(dayOf(3), `${dayOf(3)}T01:00:00.000Z`, 'sess-ret-1', 'visitor-ret-1', '(internal)', null);
    insert.run(dayOf(2), `${dayOf(2)}T01:00:00.000Z`, 'sess-ret-2', 'visitor-ret-1', '(internal)', null);
    insert.run(dayOf(3), `${dayOf(3)}T02:00:00.000Z`, 'sess-ret-3', 'visitor-ret-2', '(internal)', null);
    insert.run(dayOf(3), `${dayOf(3)}T03:00:00.000Z`, 'sess-ret-4', 'visitor-ret-3', '(internal)', null);
    insert.run(dayOf(1), `${dayOf(1)}T03:00:00.000Z`, 'sess-ret-5', 'visitor-ret-3', '(internal)', null);
  } finally {
    db.close();
  }

  const read2 = new Database(siteDbFile(), { readonly: true });
  try {
    const report = readAnalytics(read2, { days: 30, nowMs: Date.now() });
    const day1 = report.retention[0];
    const day2 = report.retention[1];
    assert.equal(day1?.offset, 1);
    assert.equal(day1?.visitors, 1, 'one visitor returned the next day');
    assert.equal(day1?.cohort, 3, 'all three could have returned');
    assert.equal(Math.round((day1?.rate ?? 0) * 100), 33);
    assert.equal(day2?.visitors, 1, 'one visitor returned two days later');
    // A site's own navigation is `(internal)` and is not acquisition: it must not appear here.
    assert.equal(
      report.sources.some((s) => s.source === '(internal)'),
      false,
    );
  } finally {
    read2.close();
  }
});
