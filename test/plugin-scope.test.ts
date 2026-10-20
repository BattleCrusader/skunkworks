/**
 * §16 S4's plugin-scope gate, re-based on the in-process model: `S1`–`S6` (§13.3.5, §13.3.7).
 *
 * These are the cases that survive the deletion of the runner, and one of them is the **only**
 * witness the capability check has left. Before D36 there were two layers: the runner refused
 * an operation outside `binding.granted` before the host was asked, and the host validated the
 * operation against the manifest. There is one layer now, so §13.1a's rule applies in full —
 * the second layer is replaced by a *mutation of the first*:
 *
 *   delete `if (!grant.includes(capability))` in `app/plugins/context.ts` and **S3** must go
 *   red naming the table it tried to touch, while **S1–S2** (the tenant binding, which never
 *   consults the grant) stay green.
 *
 * That mutation is recorded in `docs/build/S5-inprocess-report.md` §4 with the file's SHA-256
 * before and after. A test that passes because the plugin happens not to try is not a witness.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import { AppError } from '../app/errors.ts';
import { installPlugin } from '../app/plugins/install.ts';
import { packageRootHash } from '../app/plugins/manifest.ts';
import { PluginRuntime } from '../app/plugins/runtime.ts';
import { makePluginContext } from '../app/plugins/context.ts';
import { REPO, SCHEMA } from './helpers/fixture.ts';

const NOTES = join(REPO, 'test', 'fixtures', 'plugins', 'notes');
const TENANT = 'acme';
const OTHER = 'beta';
const DIGEST = 'sha256:s5-scope-app';

let dir = '';
let siteDb = '';
let runtime: PluginRuntime;

/** A site.db with the shipped DDL, one tenant's worth, and one installed package. */
function makeSite(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(readFileSync(join(SCHEMA, 'site.sql'), 'utf8'));
  db.close();
}

function writeReport(sourceDir: string, plugin: string, version: string): string {
  const { root } = packageRootHash(sourceDir);
  const path = join(dir, `${plugin}-report.json`);
  writeFileSync(
    path,
    `${JSON.stringify({ plugin, version, root_hash: root, runner_image_digest: DIGEST, ran_at: new Date().toISOString() }, null, 2)}\n`,
  );
  return path;
}

/** Install with `--allow-unsigned`: the install matrix is `plugin-load.test.ts`'s subject, not this file's. */
function installNotes(targetSite: string): void {
  installPlugin({
    siteDb: targetSite,
    pluginsRoot: join(dir, 'plugins'),
    sourceDir: NOTES,
    allowUnsigned: true,
    testReportPath: writeReport(NOTES, 'notes', '1.0.0'),
    runnerImageDigest: DIGEST,
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'skw-s5-scope-'));
  siteDb = join(dir, 'tenants', TENANT, 'site.db');
  makeSite(siteDb);
  installNotes(siteDb);
  const other = join(dir, 'tenants', OTHER, 'site.db');
  makeSite(other);
  installNotes(other);
  runtime = new PluginRuntime({ dataDir: dir, emailMode: 'off' });
  await runtime.enable(TENANT, 'notes');
  await runtime.enable(OTHER, 'notes');
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function open(): Database.Database {
  return new Database(siteDb);
}

function context(mode: 'render' | 'endpoint' | 'admin' = 'endpoint', db?: Database.Database) {
  const handle = db ?? open();
  return {
    handle,
    ctx: makePluginContext({ db: handle, tenant: TENANT, plugin: 'notes', mode, emailMode: 'off' }),
  };
}

/** Run `fn` and return the error, asserting it is a refusal with `code`. */
async function refusal(fn: () => unknown, code: string): Promise<AppError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof AppError, `expected an AppError ${code}, got ${String(err)}`);
    assert.equal((err as AppError).code, code, `expected ${code}, got ${(err as AppError).code}: ${(err as AppError).message}`);
    return err as AppError;
  }
  assert.fail(`expected ${code}, but the call succeeded`);
}

// --------------------------------------------------------------------------- S1, S2: binding

test('S1 — the facade is bound to the tenant the request resolved, and there is no tenant field', () => {
  const { handle, ctx } = context('render');
  try {
    // The tenant is closed over and exposed read-only; it is not a parameter anywhere.
    assert.equal(ctx.tenant, TENANT);
    assert.equal(ctx.plugin, 'notes');
    // The same package, enabled for two tenants, has two independent registrations — a hook
    // registered for acme is not in beta's snapshot (§13.3.3's per-tenant reason).
    assert.deepEqual(runtime.describe(TENANT).map((d) => d.plugin), ['notes']);
    assert.deepEqual(runtime.describe(OTHER).map((d) => d.plugin), ['notes']);
    assert.notEqual(
      runtime.registry.get(TENANT, 'notes')?.activationSeq,
      undefined,
      'acme has an activation',
    );
    // And the read the facade performs lands on *this* tenant's file: the row it can see is
    // this database's row, which is the only claim "bound" makes.
    const rows = ctx.facade['store.read']('p_notes_note', { limit: 1 }) as { rows: unknown[] };
    assert.deepEqual(rows.rows, []);
  } finally {
    ctx.close();
    handle.close();
  }
});

test('S2 — a tenant argument is refused SKW_E_PL_REJECTED and audited, because the attempt is the signal', async () => {
  const audited: { action: string; detail: Record<string, unknown> }[] = [];
  const handle = open();
  const ctx = makePluginContext({
    db: handle,
    tenant: TENANT,
    plugin: 'notes',
    mode: 'endpoint',
    emailMode: 'off',
    audit: (action, detail) => audited.push({ action, detail }),
  });
  try {
    const err = await refusal(() => ctx.facade['store.read']('p_notes_note', { tenant: OTHER }), 'SKW_E_PL_REJECTED');
    assert.match(err.message, /tenant/, 'the refusal names the argument');
    assert.equal(audited.length, 1);
    assert.equal(audited[0]?.action, 'plugin.tenant_argument');
    assert.equal(audited[0]?.detail['tenant'], OTHER);
    // The positive control: the same call with no tenant argument succeeds.
    const ok = ctx.facade['store.read']('p_notes_note', { limit: 1 }) as { rows: unknown[] };
    assert.deepEqual(ok.rows, []);
  } finally {
    ctx.close();
    handle.close();
  }
});

// --------------------------------------------------------------------------- S3: the witness

test('S3. an undeclared capability is refused SKW_E_PL_REJECTED before p_notes_note is touched', async () => {
  // `notes` declares store.insert / store.query / settings.* / assets.resolve. It does **not**
  // declare `store.delete`, and the table it names here (`p_notes_note`) is one it *does* own —
  // so the only thing standing between the package and a deleted row is the capability
  // comparison. Delete that comparison and this case goes red on the row count, naming the
  // table; S1–S2 stay green because neither consults the grant.
  const handle = open();
  const ctx = makePluginContext({ db: handle, tenant: TENANT, plugin: 'notes', mode: 'admin', emailMode: 'off' });
  try {
    handle.prepare(`INSERT INTO p_notes_note (body) VALUES ('keep me')`).run();
    const before = (handle.prepare('SELECT COUNT(*) AS n FROM p_notes_note').get() as { n: number }).n;
    assert.equal(before, 1);

    let refused: unknown = null;
    try {
      ctx.facade['store.delete']('p_notes_note', 1);
    } catch (err) {
      refused = err;
    }
    assert.ok(
      refused !== null,
      'store.delete on p_notes_note was NOT refused: the capability comparison in app/plugins/context.ts is gone, and this package just deleted a row it was never granted (witness §13.1a)',
    );
    assert.ok(refused instanceof AppError, `expected an AppError, got ${String(refused)}`);
    const err = refused as AppError;
    assert.equal(err.code, 'SKW_E_PL_REJECTED', `expected SKW_E_PL_REJECTED for store.delete on p_notes_note, got ${err.code}`);
    assert.match(err.message, /store\.delete needs capability store\.delete/, 'the refusal names the method and the capability');
    assert.equal((err.detail as Record<string, unknown>)['capability'], 'store.delete');
    assert.equal(
      (handle.prepare('SELECT COUNT(*) AS n FROM p_notes_note').get() as { n: number }).n,
      1,
      'the row in p_notes_note must still be there: the refusal happens before the connection is used for the operation',
    );

    // The positive control (§13.1a rule 3): a declared capability on the same table works, so
    // this suite cannot be passing by refusing everything.
    const read = ctx.facade['store.read']('p_notes_note', { limit: 5 }) as { rows: { body: string }[] };
    assert.equal(read.rows.length, 1);
    assert.equal(read.rows[0]?.body, 'keep me');

    // S3b, in the same case: with the capability declared but the **table** undeclared, the
    // refusal names the table. This is the other half of "undeclared", and it must not be the
    // same code as the capability miss — a plugin author needs to know which one they hit.
    // PL_NO_TABLE is raised by `ops.ts` as a plain `Error`: it is a message to the *plugin*, not
    // an HTTP response, so it is deliberately not an AppError and has no HTTP mapping.
    assert.throws(
      () => ctx.facade['store.read']('cms_page', { limit: 1 }),
      /SKW_E_PL_NO_TABLE: notes did not declare table "cms_page"/,
      'the refusal names the undeclared table',
    );
  } finally {
    ctx.close();
    handle.close();
  }
});

// --------------------------------------------------------------------------- S4: which handle

test('S4 — the render facade has no write method at all; endpoint and admin do', () => {
  const render = context('render');
  try {
    const facade = render.ctx.facade as unknown as Record<string, unknown>;
    for (const method of ['store.write', 'store.update', 'store.delete', 'settings.set']) {
      assert.equal(method in facade, false, `render must not have ${method} — absent, not disabled (§13.3.5)`);
      assert.equal(typeof facade[method], 'undefined');
    }
    for (const method of ['store.read', 'store.count', 'settings.get', 'assets.resolve', 'mail.send', 'log.write', 'util.now']) {
      assert.equal(typeof facade[method], 'function', `render must have ${method}`);
    }
    assert.equal(Object.isFrozen(facade), true, 'the facade is frozen: a plugin cannot reach through it');
  } finally {
    render.ctx.close();
    render.handle.close();
  }
  for (const mode of ['endpoint', 'admin'] as const) {
    const c = context(mode);
    try {
      const facade = c.ctx.facade as unknown as Record<string, unknown>;
      for (const method of ['store.write', 'store.update', 'store.delete', 'settings.set']) {
        assert.equal(typeof facade[method], 'function', `${mode} must have ${method}`);
      }
    } finally {
      c.ctx.close();
      c.handle.close();
    }
  }
});

// --------------------------------------------------------------------------- S5: ATTACH

test('S5 — a connection with a second attached database is refused and flagged for disable', async () => {
  const handle = open();
  const sibling = join(dir, 'tenants', OTHER, 'site.db');
  const ctx = makePluginContext({ db: handle, tenant: TENANT, plugin: 'notes', mode: 'admin', emailMode: 'off' });
  try {
    // ATTACH is not expressible through the facade — there is no method that takes SQL. This
    // simulates the layer *below*: a path we did not write has put a second database on the
    // connection, and the assert before the statement is what notices.
    handle.prepare('ATTACH DATABASE ? AS other').run(sibling);
    const names = (handle.pragma('database_list') as { name: string }[]).map((r) => r.name);
    assert.deepEqual(names, ['main', 'other']);

    const err = await refusal(() => ctx.facade['store.read']('p_notes_note', { limit: 1 }), 'SKW_E_PL_REJECTED');
    assert.match(err.message, /attached databases/, 'the refusal says what it found');
    const detail = err.detail as { attached: string[]; disable_plugin: boolean };
    assert.deepEqual(detail.attached, ['main', 'other']);
    assert.equal(detail.disable_plugin, true, 'the caller must be told to disable, not just refuse');
    handle.prepare('DETACH DATABASE other').run();

    // The positive control: one database again, the same call succeeds.
    const ok = ctx.facade['store.read']('p_notes_note', { limit: 1 }) as { rows: unknown[] };
    assert.ok(Array.isArray(ok.rows), 'the same call on one database returns rows');
  } finally {
    ctx.close();
    handle.close();
  }
});

// --------------------------------------------------------------------------- S6: lifetime

test('S6 — a context used after its request ended refuses SKW_E_PL_CONTEXT_ENDED, not a reused handle', () => {
  const { handle, ctx } = context('render');
  try {
    void ctx.facade['store.read']('p_notes_note', { limit: 1 });
    ctx.close();
    assert.equal(ctx.closed, true);
    assert.throws(
      () => ctx.facade['store.read']('p_notes_note', { limit: 1 }),
      /SKW_E_PL_CONTEXT_ENDED/,
      'a stashed context must not be a handle into a connection that has been reused',
    );
    assert.throws(() => ctx.facade['util.now'](), /SKW_E_PL_CONTEXT_ENDED/);
  } finally {
    handle.close();
  }
});

test('S7 — the twelve hooks are frozen: a name outside the list is not registrable', () => {
  const { handle, ctx } = context('render');
  try {
    // `download.authorize` is the absence §13.3.4 states as a control: no plugin can grant a
    // paid download. It is not in the manifest grammar and not in `ctx.on`.
    const recorder = (runtime.registry.get(TENANT, 'notes') as unknown as { hooks: Map<string, unknown> }).hooks;
    assert.ok(recorder instanceof Map);
    for (const absent of ['download.authorize', 'download.issue', 'route.resolve', 'admin.render.html']) {
      assert.equal(recorder.has(absent), false, `${absent} must not be registerable (§13.3.4)`);
    }
  } finally {
    ctx.close();
    handle.close();
  }
});
