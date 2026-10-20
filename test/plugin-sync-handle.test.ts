/**
 * `runtime.sync` must not open a SQLite connection per plugin-bearing request.
 *
 * `sync()` is called on the first line of every render and every form POST (§13.3.8: `skwctl`
 * writes the row in another process, so the app has to look). It ran one `SELECT` and paid
 * `openAdminWrite()` for the privilege — measured 730.6–767.3 µs per call at load 8.74, of which
 * the SELECT was 3.0 µs (§9.5 of `docs/build/S5-inprocess-report.md`). 99.6% of the cost was the
 * connection.
 *
 * Three things are asserted, and the first two pull in opposite directions:
 *
 *   S1  **the connection count per request is zero after the first** — a per-tenant handle that
 *       is reused, counted by `connectionCount()` in `app/db/classes.ts` (a monotonic diagnostic,
 *       so the gate takes deltas);
 *   S2  **the cache is not a snapshot** — the handle is only worth having if a row written by
 *       another connection is seen by the next `sync()`. That is the property a cached handle can
 *       break, and it is why the SELECT still runs on every call;
 *   S3  **a replaced file is noticed** — the handle is keyed on the file's identity, not its path,
 *       because the restore path (`skwctl tenant restore`) replaces the inode and a handle to the
 *       old one would answer with rows the site no longer has.
 *
 * The handle is a `render-read` connection (`openRenderRead`: `readonly` + `query_only=1`), not an
 * `admin-write` one: `sync` reads a table and a `user_version`, and a read path that can write is
 * a read path that can corrupt. `assertClass` enforces the pragmas on every open.
 */
import assert from 'node:assert/strict';
import { copyFileSync, renameSync, statSync } from 'node:fs';
import { test } from 'node:test';

import { connectionCount, openAdminWrite } from '../app/db/classes.ts';
import { PluginRuntime } from '../app/plugins/runtime.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';

const TENANT = 'acme';

function runtimeFor(fixture: Fixture): PluginRuntime {
  return new PluginRuntime({ dataDir: fixture.dir, emailMode: 'off' });
}

test('S1 — twenty syncs after the first open one connection, not twenty', async () => {
  const fixture = makeFixture({ specs: [{ key: TENANT, hosts: ['acme.test'], title: 'Acme' }] });
  try {
    const runtime = runtimeFor(fixture);
    try {
      // The first call is allowed to open: there is nothing to reuse yet.
      const before = connectionCount();
      await runtime.sync(TENANT);
      const first = connectionCount() - before;
      assert.equal(first, 1, `the first sync opened ${first} connections, expected exactly 1`);

      // Every request after it is a reuse. Twenty of them: one per request on a busy tenant is
      // the case this exists for, and one is not a measurement.
      const warm = connectionCount();
      for (let i = 0; i < 20; i += 1) await runtime.sync(TENANT);
      const after = connectionCount() - warm;
      assert.equal(
        after,
        0,
        `twenty syncs opened ${after} connections (a per-request handle would open 20, ~0.75 ms each)`,
      );
    } finally {
      runtime.closeSyncHandles();
    }
  } finally {
    fixture.cleanup();
  }
});

test('S2 — the cached handle is not a snapshot: a row another connection writes is seen next sync', async () => {
  const fixture = makeFixture({ specs: [{ key: TENANT, hosts: ['acme.test'], title: 'Acme' }] });
  try {
    const runtime = runtimeFor(fixture);
    try {
      await runtime.sync(TENANT);
      await runtime.sync(TENANT);

      // A row, written the way `skwctl plugin install` would write it: a *different* connection,
      // in the same process, after the handle was already cached. The columns are the schema's
      // own (`publisher` and `test_report_sha` are NOT NULL / checked for an enabled row).
      const writer = openAdminWrite(fixture.sitePath(TENANT), 5000);
      try {
        writer
          .prepare(
            `INSERT INTO cms_plugin_installed
               (plugin_id, version, manifest_json, root_hash, publisher, enabled, installed_at, signature_state, test_report_sha)
             VALUES ('gate-probe', '1.0.0', '{}', ?, 'gate', 1, '2026-10-21T00:00:00.000Z', 'unsigned', 'report-sha')`,
          )
          .run('a'.repeat(64));
      } finally {
        writer.close();
      }

      // The next sync sees it. It cannot activate it — there is no package on disk — so it marks
      // it failed, which is observable and is exactly what `sync` is for.
      //
      // The *read* is a reuse: `syncStats().opens` must not move. (`connectionCount()` does move
      // by one, and honestly so: `enable()` opens its own admin-write connection to record the
      // failure. That is an activation, not a per-request read.)
      const before = runtime.syncStats();
      await runtime.sync(TENANT);
      const after = runtime.syncStats();
      assert.equal(after.opens, before.opens, 'the sync that discovered the new row opened a read connection of its own');
      assert.equal(after.reuses, before.reuses + 1, 'the discovery did not use the cached handle');
      const notices = runtime.noticesFor(TENANT);
      assert.equal(notices.length, 1, `expected one notice for the row it found, got ${JSON.stringify(notices)}`);
      assert.equal(notices[0]?.plugin, 'gate-probe');
      assert.match(String(notices[0]?.code), /^SKW_E_PL_/, 'the notice must carry a plugin code, not a bare message');
      assert.equal(runtime.registry.has(TENANT, 'gate-probe'), false, 'a package that is not on disk was activated');

      // And the row it wrote is `enabled = 0` now — read through a second connection, because the
      // point is that the writer's row reached the database, not that a read agrees with a write.
      const reader = openAdminWrite(fixture.sitePath(TENANT), 5000);
      try {
        const row = reader.prepare(`SELECT enabled FROM cms_plugin_installed WHERE plugin_id = 'gate-probe'`).get() as
          | { enabled: number }
          | undefined;
        assert.equal(row?.enabled, 0, 'a failed activation left the row enabled');
      } finally {
        reader.close();
      }
    } finally {
      runtime.closeSyncHandles();
    }
  } finally {
    fixture.cleanup();
  }
});

test('S4 — an open handle blocks `PRAGMA journal_mode`; `discardSyncHandle` is the release', async () => {
  // The cost of caching, measured rather than assumed: a readonly connection still holds a shared
  // lock, and flipping the journal mode needs an exclusive one. That is why `boot()` does not cache
  // (it runs before any request and must leave no file open) and why a restore path has a way to
  // drop the handle. Without this test the constraint is a comment that the next edit can break.
  const fixture = makeFixture({ specs: [{ key: TENANT, hosts: ['acme.test'], title: 'Acme' }] });
  try {
    const runtime = runtimeFor(fixture);
    try {
      await runtime.sync(TENANT);
      assert.equal(runtime.syncStats().size, 1, 'sync() did not cache a handle');
      const other = openAdminWrite(fixture.sitePath(TENANT), 5000);
      try {
        assert.throws(
          () => other.pragma('journal_mode = DELETE'),
          /database is locked/i,
          'an open cached handle did not block the journal-mode flip — the constraint this documents is gone',
        );
      } finally {
        other.close();
      }
      runtime.discardSyncHandle(TENANT);
      const after = openAdminWrite(fixture.sitePath(TENANT), 5000);
      try {
        assert.doesNotThrow(() => after.pragma('journal_mode = DELETE'), 'the flip still fails after the handle was dropped');
      } finally {
        after.close();
      }
    } finally {
      runtime.closeSyncHandles();
    }
  } finally {
    fixture.cleanup();
  }
});

test('S3 — a replaced database file is noticed: the handle is keyed on the file, not the path', async () => {
  const fixture = makeFixture({ specs: [{ key: TENANT, hosts: ['acme.test'], title: 'Acme' }] });
  try {
    const runtime = runtimeFor(fixture);
    try {
      const file = fixture.sitePath(TENANT);
      await runtime.sync(TENANT);
      const warm = connectionCount();
      await runtime.sync(TENANT);
      assert.equal(connectionCount() - warm, 0, 'the second sync should have reused the handle');

      // What `skwctl tenant restore` does: the path is replaced with a different file. Unlinking
      // first is what makes the copy a *new* inode rather than a truncation of the old one.
      const inoBefore = statSync(file).ino;
      renameSync(file, `${file}.restore`);
      copyFileSync(`${file}.restore`, file);
      assert.notEqual(statSync(file).ino, inoBefore, 'the harness replaced the path, not the file');

      const reopened = connectionCount();
      await runtime.sync(TENANT);
      assert.equal(
        connectionCount() - reopened,
        1,
        'a replaced file must be reopened, not read through a handle to the inode it replaced',
      );
    } finally {
      runtime.closeSyncHandles();
    }
  } finally {
    fixture.cleanup();
  }
});
