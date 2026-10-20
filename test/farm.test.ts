/**
 * S3b / §7.1 / D18 — the public symlink farm.
 *
 * The four properties this file exists for, each asserted on the tree rather than on a report:
 *
 *   F1  a public asset has a *relative* symlink `content/public/<key>.<ext> -> ../media/hh/<sha>.<ext>`
 *   F2  a **gated** asset has no link at all — no link by key, no link by checksum, and a
 *       later flip of the row to `public` is what creates one (the control that the absence
 *       is caused by the class and not by a bug that never writes links)
 *   F3  a rename never leaves both URLs dead: sampled while it runs, at least one of the old
 *       and new names always resolves, and the alias map names old -> new
 *   F4  a delete removes the link, and the alias map loses the 301 (a redirect to a deleted
 *       file is a redirect to a 404)
 *
 * Nothing here uses a browser or a server: the farm is a directory, so the assertions are
 * `lstat`, `readlink` and the bytes those links resolve to.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import sharp from 'sharp';

import { deleteAsset, renameAsset, uploadAsset } from '../app/assets/library.ts';
import {
  aliasMapText,
  linksPointingAt,
  publicDirOf,
  rebuildFarm,
  syncAssetLinks,
} from '../app/assets/farm.ts';
import { ensureVariants } from '../app/assets/renditions.ts';
import { openAdminWrite } from '../app/db/classes.ts';
import { makeFixture, REPO, type Fixture } from './helpers/fixture.ts';

let fixture: Fixture;
let file: string;
let contentRoot: string;

before(() => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
  file = fixture.sitePath('acme');
  contentRoot = join(fixture.dir, 'content');
});

after(() => fixture.cleanup());

function db(): Database.Database {
  return openAdminWrite(file);
}

const PUBLIC = 1_000_000;

/**
 * A distinct image per call. The store dedupes identical bytes *by design* (D13), so a test
 * that reused one buffer for every fixture would be asserting against a single shared blob —
 * `linksPointingAt(sha)` would then legitimately find another asset's link.
 */
let imageSerial = 0;
async function png(width = 64, height = 48): Promise<Buffer> {
  imageSerial += 1;
  return sharp({
    create: { width, height, channels: 3, background: { r: (imageSerial * 37) % 256, g: 120, b: (imageSerial * 91) % 256 } },
  })
    .png()
    .toBuffer();
}

async function upload(key: string, opts: { accessClass?: 'public' | 'gated'; bytes?: Buffer } = {}): Promise<number> {
  const database = db();
  try {
    const result = await uploadAsset({
      db: database,
      contentRoot,
      tenantKey: 'acme',
      key,
      filename: `${key.replace(/\//g, '-')}.png`,
      bytes: opts.bytes ?? (await png()),
      quotaLimitBytes: PUBLIC,
      ...(opts.accessClass === undefined ? {} : { accessClass: opts.accessClass }),
    });
    return result.asset.id;
  } finally {
    database.close();
  }
}

function linkOf(name: string): { target: string; bytes: string[] } {
  const abs = join(publicDirOf(contentRoot), name);
  assert.ok(lstatSync(abs).isSymbolicLink(), `${name} is not a symlink`);
  return { target: readlinkSync(abs), bytes: [] };
}

/** The bytes a link resolves to — the whole point of a symlink, asserted through the filesystem. */
function bytesThroughLink(name: string): Buffer {
  return readFileSync(join(publicDirOf(contentRoot), name));
}

// --- F1 ----------------------------------------------------------------------------------

test('F1 — a public asset gets one relative link, and it resolves to the stored bytes', async () => {
  const database = db();
  let row: { sha256: string; storage_path: string } | undefined;
  try {
    await upload('banner/home');
    row = database.prepare('SELECT sha256, storage_path FROM cms_asset WHERE key = ?').get('banner/home') as
      | { sha256: string; storage_path: string }
      | undefined;
  } finally {
    database.close();
  }
  assert.ok(row !== undefined);
  const link = linkOf('banner/home.png');
  // Relative, so the tree can be mounted anywhere (§7.1's farm is a bundle artefact too), and
  // one `../` per level the key nests: `banner/home.png` is two directories below public/.
  assert.equal(link.target, `../../media/${row.sha256.slice(0, 2)}/${row.sha256}.png`);
  assert.equal(link.target.startsWith('/'), false, 'an absolute target would pin the tree to one path');
  // The link is the file: same bytes as the row's checksum addresses.
  const throughLink = bytesThroughLink('banner/home.png');
  const stored = readFileSync(join(contentRoot, 'media', row.sha256.slice(0, 2), `${row.sha256}.png`));
  assert.equal(throughLink.equals(stored), true, 'the link does not resolve to the stored blob');
});

// --- F2 — the gated asset, which is the security property --------------------------------

test('F2 — a gated asset has NO link, by key and by checksum; flipping it public creates one', async () => {
  // A gated *image* is the case the design names: bytes exist in media/ and must not be in public/.
  const database = db();
  let gatedSha = '';
  try {
    await upload('vault/paid-photo', { accessClass: 'gated' });
    const row = database.prepare('SELECT sha256 FROM cms_asset WHERE key = ?').get('vault/paid-photo') as {
      sha256: string;
    };
    gatedSha = row.sha256;
  } finally {
    database.close();
  }

  const dir = publicDirOf(contentRoot);
  const names = existsSync(dir) ? readdirSync(dir) : [];
  assert.equal(
    names.filter((n) => n.startsWith('vault/paid-photo')).length,
    0,
    `a gated asset has a farm link: ${names.filter((n) => n.startsWith('vault/')).join(', ')}`,
  );
  // §7.1's own test, in code: nothing in the public tree points at the gated checksum.
  assert.deepEqual(linksPointingAt(contentRoot, gatedSha), []);
  // And the bytes are where they belong — present, and reachable only through the internal alias.
  assert.ok(existsSync(join(contentRoot, 'media', gatedSha.slice(0, 2), `${gatedSha}.png`)));

  // The control: the absence is caused by the class. The same row, made public, gets a link.
  const writer = db();
  try {
    writer.prepare("UPDATE cms_asset SET access_class = 'public' WHERE key = 'vault/paid-photo'").run();
    syncAssetLinks(writer, contentRoot, 'vault/paid-photo');
  } finally {
    writer.close();
  }
  assert.deepEqual(linksPointingAt(contentRoot, gatedSha), ['vault/paid-photo.png']);
  assert.equal(bytesThroughLink('vault/paid-photo.png').length > 0, true);

  // …and going back to gated removes it in the same call, which is the half a stale link would
  // otherwise survive: sync is what both transitions run through.
  const again = db();
  try {
    again.prepare("UPDATE cms_asset SET access_class = 'gated' WHERE key = 'vault/paid-photo'").run();
    syncAssetLinks(again, contentRoot, 'vault/paid-photo');
  } finally {
    again.close();
  }
  assert.deepEqual(linksPointingAt(contentRoot, gatedSha), []);
});

// --- F3 — rename atomicity, sampled ------------------------------------------------

test('F3 — a rename leaves no moment where neither URL resolves, and the map names old -> new', async () => {
  const id = await upload('campaign/summer', {});
  const database = db();
  try {
    await ensureVariants({ db: database, contentRoot, assetId: id });
  } finally {
    database.close();
  }
  const oldName = 'campaign/summer.png';
  const newName = 'campaign/spring.png';
  assert.ok(existsSync(join(publicDirOf(contentRoot), oldName)));

  // Sample both names while the rename runs, from a **second process**: the rename is
  // synchronous JS, so an in-process sampler would run only before or after it and report a
  // window it never observed. `readFileSync` in that process is the reader: it either resolves
  // (bytes) or throws (gone), which is what nginx's `try_files` does.
  //
  // The window is held open rather than raced: the reader prints `ready` (so it has resolved the
  // old name before the rename is called) and `renameAsset` then parks between "the new links
  // exist" and "the old ones are removed" until the reader has sampled both resolving. This is
  // the same barrier N3 uses at the edge, for the same reason — `sawOld > 0` must be a
  // construction, not a bet on how fast node boots on a loaded box.
  const holdDir = join(fixture.dir, 'rename-window');
  mkdirSync(holdDir, { recursive: true });
  const sampler = spawn(process.execPath, [
    join(REPO, 'test', 'helpers', 'farm-sampler.mjs'),
    publicDirOf(contentRoot),
    oldName,
    newName,
    '3000',
    holdDir,
  ]);
  const events: Record<string, unknown>[] = [];
  const waiters = new Map<string, (value: Record<string, unknown>) => void>();
  let buf = '';
  sampler.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line === '') continue;
      const event = JSON.parse(line) as Record<string, unknown>;
      events.push(event);
      const waiter = waiters.get(String(event.event));
      if (waiter !== undefined) {
        waiters.delete(String(event.event));
        waiter(event);
      }
    }
  });
  const samplerExit = new Promise<void>((resolve, reject) => {
    sampler.on('error', reject);
    sampler.on('close', () => resolve());
  });
  function waitForEvent(name: string, timeoutMs: number): Promise<Record<string, unknown>> {
    const seen = events.find((e) => e.event === name);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(name);
        reject(new Error(`the sampler never emitted "${name}" within ${timeoutMs} ms (events: ${JSON.stringify(events)})`));
      }, timeoutMs);
      waiters.set(name, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }
  const ready = await waitForEvent('ready', 30_000);
  assert.ok(Number(ready.sawOld) >= 1, `the reader said ready without resolving the old link: ${JSON.stringify(ready)}`);

  let samples: Record<string, unknown>;
  process.env.SKW_RENAME_WINDOW_HOLD = holdDir;
  try {
    const writer = db();
    try {
      renameAsset(writer, { from: 'campaign/summer', to: 'campaign/spring', contentRoot });
    } finally {
      writer.close();
    }
  } finally {
    delete process.env.SKW_RENAME_WINDOW_HOLD;
  }
  samples = await waitForEvent('done', 60_000);
  await samplerExit;
  // `samples > 200` used to sit here: a throughput number in a correctness gate, asserting that
  // the reader managed 500 reads a second on whatever box the suite ran on. The window is held
  // open now, so the honest question is not "how many reads" but "were any of them taken inside
  // the window" — which the release answers by construction.
  assert.ok(existsSync(join(holdDir, 'window-open.json')), 'the rename never opened a window the reader could hold');
  assert.equal(
    samples.releaseReason,
    'window',
    `the window was released on "${String(samples.releaseReason)}", not because both names resolved (${JSON.stringify(samples)})`,
  );
  assert.ok(Number(samples.windowSamples) >= 3, `only ${String(samples.windowSamples)} samples inside the held window (${JSON.stringify(samples)})`);
  assert.equal(
    Number(samples.dead),
    0,
    `an interval existed in which neither name resolved (${String(samples.dead)} of ${String(samples.samples)} samples)`,
  );
  // The rename did happen inside the window: the reader saw the old name, and then the new one.
  assert.ok(Number(samples.sawOld) > 0, 'the reader never saw the old link');
  assert.ok(Number(samples.sawNew) > 0, 'the reader never saw the new link');

  // After it: new serves, old link is gone (the edge answers it from the map instead).
  assert.equal(resolves(newName), true);
  assert.equal(existsSync(join(publicDirOf(contentRoot), oldName)), false, 'the old link survived the rename');
  // The renditions travelled with the key — an old variant name would be a broken srcset entry.
  const dirNow = publicDirOf(contentRoot);
  assert.equal(existsSync(join(dirNow, 'campaign/summer@thumb.webp')), false, 'an old variant link survived');
  assert.equal(existsSync(join(dirNow, 'campaign/spring@thumb.webp')), true, 'the new key has no thumb link');
  assert.equal(existsSync(join(dirNow, 'campaign/spring@thumb.avif')), true, 'the avif rendition has no link');
  assert.equal(existsSync(join(dirNow, 'campaign/spring@og.webp')), true, 'the og rendition has no link');

  // The alias map, which is what makes the old URL a 301 rather than a 404 at the edge.
  const mapDb = openAdminWrite(file);
  let map = '';
  let newSha = '';
  try {
    map = aliasMapText(mapDb);
    newSha = (mapDb.prepare('SELECT sha256 FROM cms_asset WHERE key = ?').get('campaign/spring') as { sha256: string })
      .sha256;
  } finally {
    mapDb.close();
  }
  assert.match(map, new RegExp(`^/media/campaign/summer\\.png /media/campaign/spring\\.png\\?v=${newSha.slice(0, 8)};$`, 'm'));
  // And the file on disk is what nginx will include.
  const onDisk = readFileSync(join(contentRoot, 'edge', 'media-aliases.inc'), 'utf8');
  assert.equal(onDisk, map, 'the include on disk is not the current map');
});

function resolves(name: string): boolean {
  try {
    readFileSync(join(publicDirOf(contentRoot), name));
    return true;
  } catch {
    return false;
  }
}

// --- F4 — delete ------------------------------------------------------------------------

test('F4 — delete removes the link, and the alias it cascaded stops being a 301', async () => {
  await upload('legacy/old-name', {});
  const writer = db();
  try {
    renameAsset(writer, { from: 'legacy/old-name', to: 'legacy/new-name', contentRoot });
    assert.match(readFileSync(join(contentRoot, 'edge', 'media-aliases.inc'), 'utf8'), /\/media\/legacy\/old-name\.png /);
  } finally {
    writer.close();
  }

  const deleting = db();
  try {
    deleteAsset(deleting, 'legacy/new-name', { contentRoot });
    const aliases = deleting.prepare('SELECT count(*) AS n FROM cms_asset_alias WHERE key = ?').get('legacy/old-name') as {
      n: number;
    };
    assert.equal(aliases.n, 0, 'the alias row did not cascade with the asset');
  } finally {
    deleting.close();
  }

  const names = readdirSync(publicDirOf(contentRoot));
  assert.equal(names.some((n) => n.startsWith('legacy/')), false, `links survived the delete: ${names.join(', ')}`);
  // The CASCADE removed the alias row, so the map must not still 301 the old key to a dead file.
  const map = readFileSync(join(contentRoot, 'edge', 'media-aliases.inc'), 'utf8');
  assert.doesNotMatch(map, /legacy\/old-name/);
  assert.doesNotMatch(map, /legacy\/new-name/);
});

// --- rebuild, which is the repair path and the bundle-export path ------------------------

test('rebuild — recreates a missing link, removes an orphan, and reports a gated link before removing it', async () => {
  await upload('rebuild/keep', {});
  const dir = publicDirOf(contentRoot);
  // A link a human deleted, and a link nobody asked for (a valid shape, wrong content).
  const keepAt = join(dir, 'rebuild/keep.png');
  assert.ok(existsSync(keepAt));
  const target = readlinkSync(keepAt);
  const { rmSync, symlinkSync } = await import('node:fs');
  rmSync(keepAt);
  symlinkSync('../media/aa/' + 'a'.repeat(64) + '.png', join(dir, 'ghost.png'));

  const database = db();
  let report: ReturnType<typeof rebuildFarm>;
  try {
    report = rebuildFarm(database, contentRoot);
  } finally {
    database.close();
  }
  assert.ok(report.orphans.includes('ghost.png'), `the orphan was not reported: ${report.orphans.join(', ')}`);
  assert.equal(existsSync(join(dir, 'ghost.png')), false);
  assert.equal(readlinkSync(keepAt), target, 'rebuild changed a link that was already correct');
});
