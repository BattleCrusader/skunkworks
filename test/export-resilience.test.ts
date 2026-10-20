/**
 * S4c item 5 — **resilience on a real disk and under real contention**.
 *
 * Two conditions the code paths already had names for and no fixture had ever driven
 * (S4b report §9.4): `SKW_E_EXP_INSUFFICIENT_DISK` and a second writer on one tenant.
 *
 *   D1  A volume with no space left: the export refuses **before writing**, names the bytes
 *       it needs, and leaves every existing byte where it was — the tenant's `site.db` and a
 *       sentinel file on the volume are hashed before and after.
 *   D2  The writer itself, on a full volume: `writeTree` raises `DiskFullError` with the real
 *       `ENOSPC`, removes its temporary, and does not replace the file it was writing. This
 *       is the half the precheck cannot reach — a precheck makes the *race* impossible only
 *       for a single writer with an accurate estimate.
 *   D3  Two writers, one tenant: the second gets `SKW_E_EXP_WRITER_ACTIVE` (exit 26) naming the
 *       lock, and writes **nothing** — no half tree, no second snapshot.
 *   D4  A stale lock (its holder is dead) is taken over, so a crash at 03:00 is not an outage.
 *
 * The filesystem is real (`hdiutil` disk image, `test/helpers/full-disk.ts`); the second
 * writer is a real process holding the lock, not a simulated flag.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runExport } from '../app/export/index.ts';
import { writeTree } from '../app/export/tree.ts';
import { REPO, makeFixture, type Fixture } from '../test/helpers/fixture.ts';
import { fillUntil, makeSmallVolume, type SmallVolume } from '../test/helpers/full-disk.ts';

const NOW = '2026-10-20T12:00:00.000Z';
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

function fixture(): Fixture {
  const f = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
  const db = new Database(f.sitePath('acme'));
  try {
    // Enough bytes that 2× them cannot fit in a 1 MB volume once the filler is in.
    db.prepare(
      `INSERT INTO cms_page (path, slug, title, status, template, body_html, published_at)
       VALUES ('/big', 'big', 'Big', 'published', 'page', ?, '2026-01-01T00:00:00.000Z')`,
    ).run(`<h1>Big</h1><p>${'x'.repeat(300_000)}</p>`);
  } finally {
    db.close();
  }
  return f;
}

let volume: SmallVolume | undefined;

function fullVolume(sizeMb = 1, leaveBytes = 12 * 1024): SmallVolume {
  volume = makeSmallVolume(sizeMb);
  fillUntil(volume, leaveBytes);
  return volume;
}

test('D1 — a full disk is refused before the write, leaving every existing byte intact', () => {
  const f = fixture();
  const vol = fullVolume();
  try {
    const sentinel = join(vol.root, 'sentinel.txt');
    writeFileSync(sentinel, 'bytes that must survive the refusal\n');
    const before = { sentinel: sha(sentinel), site: sha(f.sitePath('acme')) };

    const db = new Database(f.sitePath('acme'), { readonly: true });
    try {
      const result = runExport({
        target: 'static',
        db,
        tenantKey: 'acme',
        out: join(vol.root, 'out'),
        exportNow: NOW,
        contentRoot: join(f.dir, 'content'),
        repoRoot: REPO,
        tmpDir: f.dir,
      });
      assert.equal(result.ok, false, 'a full disk must refuse, not truncate');
      const refusal = (result as { refusals: { code: string; exit: number; detail: Record<string, unknown> }[] }).refusals[0];
      assert.equal(refusal?.code, 'SKW_E_EXP_INSUFFICIENT_DISK');
      assert.equal(refusal?.exit, 25);
      assert.ok(Number(refusal?.detail.free_bytes) < Number(refusal?.detail.projected_bytes) * 2);
    } finally {
      db.close();
    }

    assert.equal(existsSync(join(vol.root, 'out')), false, 'nothing was written');
    assert.equal(sha(sentinel), before.sentinel, 'the sentinel is byte-identical');
    assert.equal(sha(f.sitePath('acme')), before.site, "the tenant's database is byte-identical");
  } finally {
    f.cleanup();
  }
});

test('D2 — the writer itself, on a full volume: DiskFullError, no temporary, previous bytes intact', () => {
  const vol = fullVolume(1, 8 * 1024);
  try {
    const sentinel = join(vol.root, 'sentinel.txt');
    writeFileSync(sentinel, 'previous bytes\n');
    const before = sha(sentinel);

    // Directly at `writeTree`, because this is the path a racing writer takes when the
    // precheck's number was true a millisecond ago: 512 KiB into a volume with 8 KiB free.
    assert.throws(
      () =>
        writeTree(
          join(vol.root, 'out'),
          [{ path: 'page.html', bytes: Buffer.alloc(512 * 1024, 0x62) }],
          Date.parse(NOW),
        ),
      (err: unknown) => {
        const e = err as { name?: string; code?: string };
        assert.equal(e.name, 'DiskFullError');
        assert.equal(e.code, 'ENOSPC');
        return true;
      },
    );

    assert.equal(sha(sentinel), before, 'the sentinel is byte-identical');
    const leftovers = readdirSync(join(vol.root, 'out')).filter((name) => name.includes('.skw-tmp-'));
    assert.deepEqual(leftovers, [], 'no temporary file survives a failed write');
    assert.equal(existsSync(join(vol.root, 'out', 'page.html')), false, 'a partial page is not renamed into place');
  } finally {
    vol.detach();
  }
});

test('D3 — a second writer on one tenant gets a named refusal and writes nothing', () => {
  const f = fixture();
  try {
    // A live holder: this process. The lock's protocol is `O_EXCL` + pid, so a test that is
    // alive *is* the first writer as far as the second one can tell — which is the point.
    const lock = join(f.dir, '.export-acme.lock');
    writeFileSync(lock, `${process.pid}\n`);
    const out = join(f.dir, 'out-second');
    const siteBefore = sha(f.sitePath('acme'));
    const db = new Database(f.sitePath('acme'), { readonly: true });
    try {
      const result = runExport({
        target: 'static',
        db,
        tenantKey: 'acme',
        out,
        exportNow: NOW,
        contentRoot: join(f.dir, 'content'),
        repoRoot: REPO,
        tmpDir: f.dir,
      });
      assert.equal(result.ok, false);
      const refusal = (result as { refusals: { code: string; exit: number; detail: Record<string, unknown> }[] }).refusals[0];
      assert.equal(refusal?.code, 'SKW_E_EXP_WRITER_ACTIVE');
      assert.equal(refusal?.exit, 26);
      assert.equal(refusal?.detail.tenant, 'acme');
      assert.equal(refusal?.detail.lock, lock);
    } finally {
      db.close();
    }
    assert.equal(existsSync(out), false, 'the loser wrote no tree');
    // "No partial row": the loser's snapshot is never taken, so the tenant's own database is
    // byte-identical — not "consistent enough", identical.
    assert.equal(sha(f.sitePath('acme')), siteBefore, "the loser did not touch the tenant's database");
    assert.equal(readFileSync(lock, 'utf8'), `${process.pid}\n`, "the loser did not touch the winner's lock");
    rmSync(lock, { force: true });
  } finally {
    f.cleanup();
  }
});

test('D4 — a stale lock (holder gone) is taken over, then released: a crash is not an outage', () => {
  const f = fixture();
  try {
    // A pid that certainly existed and certainly exited.
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = child.pid as number;
    assert.equal(typeof deadPid, 'number');
    const lock = join(f.dir, '.export-acme.lock');
    writeFileSync(lock, `${deadPid}\n`);

    const out = join(f.dir, 'out-taken');
    const db = new Database(f.sitePath('acme'), { readonly: true });
    try {
      const result = runExport({
        target: 'static',
        db,
        tenantKey: 'acme',
        out,
        exportNow: NOW,
        contentRoot: join(f.dir, 'content'),
        repoRoot: REPO,
        tmpDir: f.dir,
      });
      assert.equal(result.ok, true, `a stale lock must not block: ${JSON.stringify((result as { refusals?: unknown }).refusals)}`);
    } finally {
      db.close();
    }
    assert.equal(existsSync(out), true);
    assert.equal(existsSync(lock), false, 'the winner releases the lock it took over');
  } finally {
    f.cleanup();
  }
});

test('D5 — the CLI maps both refusals to their §11.3 exit codes', () => {
  const f = fixture();
  const vol = fullVolume();
  try {
    const out = join(vol.root, 'out-cli');
    const full = spawnSync(
      'node',
      ['app/cli/export.ts', '--target', 'static', '--tenant', 'acme', '--out', out, '--data-dir', f.dir, '--now', NOW],
      { cwd: REPO, encoding: 'utf8', timeout: 120_000 },
    );
    assert.equal(full.status, 25, `${full.stderr}\n${full.stdout}`);
    assert.match(full.stderr, /SKW_E_EXP_INSUFFICIENT_DISK/);
    assert.match(full.stderr, /refused; nothing was written/);

    writeFileSync(join(f.dir, '.export-acme.lock'), `${process.pid}\n`);
    const busy = spawnSync(
      'node',
      ['app/cli/export.ts', '--target', 'static', '--tenant', 'acme', '--out', join(f.dir, 'out-cli'), '--data-dir', f.dir, '--now', NOW],
      { cwd: REPO, encoding: 'utf8', timeout: 120_000 },
    );
    assert.equal(busy.status, 26, `${busy.stderr}\n${busy.stdout}`);
    assert.match(busy.stderr, /SKW_E_EXP_WRITER_ACTIVE/);
    rmSync(join(f.dir, '.export-acme.lock'), { force: true });
  } finally {
    if (volume !== undefined) volume.detach();
    volume = undefined;
    f.cleanup();
  }
});
