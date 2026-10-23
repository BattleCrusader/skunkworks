/**
 * S8x — a theme is a package, and the screen says what happened.
 *
 * Two defects and one feature, each measured against the running app:
 *
 *   1. **The upload said nothing.** `POST /themes/upload` answered `303 …?result=uploaded`, the
 *      screen took that value, passed it to `layout({ flash })` — and `layout` had no such prop, so
 *      every confirmation and every refusal was dropped on the floor. The operator's report was
 *      "theme uploading isn't working", and it was not: the theme was stored, the screen was mute.
 *   2. **A theme was one stylesheet.** A look with a logo, a photograph or a display face had
 *      nowhere to put those bytes. A package (`.zip`) now carries `theme.css` plus the files its
 *      rules name; the bytes land beside the tenant's database, `cms_theme_asset` is the link, and
 *      the stylesheet is rewritten once, at upload, so `/_theme/<key>/assets/hero.jpg?v=<sha8>` is
 *      what the browser fetches and what an export writes.
 *   3. **Reading a zip is not a dependency.** `readZip` parses the central directory and inflates
 *      raw deflate with `zlib` — the same "no new runtime dependency" rule `archive.ts` states.
 *
 * Everything here goes through the app: a real multipart body, a real redirect, a real GET of the
 * stylesheet and the asset. The zip is built in the test so the bytes are known.
 */
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { after, before, test } from 'node:test';

import { openAdminWrite } from '../app/db/classes.ts';
import { loadEnv } from '../app/env.ts';
import { themeAssetsRoot } from '../app/render/themes.ts';
import { readThemeBundle, rewriteAssetUrls } from '../app/render/theme-bundle.ts';
import { readZip } from '../app/render/zip.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { ADMIN_HOST, ADMIN_ORIGIN, TOTP_SECRET, openSession, seedUser, type Sessioned } from './helpers/admin.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, type Res } from './helpers/http.ts';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let session: Sessioned;

/** The bytes every test can point at. */
const HERO = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#a8451c"/></svg>', 'utf8');
const SHEET = 'body{background:url(assets/hero.svg)}\n.s-probe{color:#123456}\n';

interface Member {
  name: string;
  bytes: Buffer;
  /** False for a stored member, true to exercise the deflate path. */
  deflate?: boolean;
}

/**
 * Build a zip in memory.
 *
 * Stored members by default and deflate on request, because the reader has to handle both and a
 * reader tested only against what this writer emits is a reader tested against itself.
 */
function zipOf(members: Member[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name, 'utf8');
    const packed = member.deflate === true ? deflateRawSync(member.bytes) : member.bytes;
    const crc = crc32(member.bytes) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x0403_4b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(member.deflate === true ? 8 : 0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(member.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x0201_4b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(member.deflate === true ? 8 : 0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(member.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    // A regular file, 0644: the high 16 bits of the external attributes are the unix mode.
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x0605_4b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, directory, end]);
}

/** A multipart body with a binary file part, which the existing helper cannot express. */
function upload(filename: string, bytes: Buffer, fields: Record<string, string> = {}): Promise<Res> {
  const boundary = '----skwbundleboundary';
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries({ ...fields, csrf: session.csrfToken })) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="theme"; filename="${filename}"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n',
      'utf8',
    ),
  );
  chunks.push(bytes);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return call({
    port,
    path: '/admin/t/acme/themes/upload',
    method: 'POST',
    host: ADMIN_HOST,
    headers: {
      origin: ADMIN_ORIGIN,
      'content-type': `multipart/form-data; boundary=${boundary}`,
      cookie: session.cookie,
    },
    body: Buffer.concat(chunks),
  });
}

function screen(query = ''): Promise<Res> {
  return call({ port, path: `/admin/t/acme/themes${query}`, host: ADMIN_HOST, headers: { cookie: session.cookie } });
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: [ADMIN_HOST], title: 'Acme' }] });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'owner@acme.test', totpSecret: TOTP_SECRET });
  handle = await buildApp({ env: loadEnv(fixture.env) });
  port = await handle.app.listen({ port: 0, host: '127.0.0.1' }).then(() => (handle.app.server.address() as { port: number }).port);
  session = await openSession({ port, key: 'acme', email: 'owner@acme.test' });
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

test('S8x-1. the screen says what the upload did — in colour, not silently', async () => {
  const res = await upload('plain.css', Buffer.from(SHEET, 'utf8'));
  assert.equal(res.status, 303);
  assert.match(String(res.headers.location), /\?result=uploaded$/);

  const after1 = await screen('?result=uploaded');
  assert.equal(after1.status, 200);
  assert.match(after1.body, /class="acct__flash acct__flash--ok"/, 'a good outcome is announced in green');
  assert.match(after1.body, /Theme uploaded\. It is not active yet/, 'and it says what to do next');

  // A refusal is the same machinery with the other kind: this is the half that was silent too.
  const bad = await screen('?result=large');
  assert.match(bad.body, /class="acct__flash acct__flash--bad"/);
  assert.match(bad.body, /exceeds the theme limit/);

  // And an outcome with no canned sentence — an activate/delete refusal carries the reason — is
  // shown verbatim rather than swallowed.
  const custom = await screen(`?result=${encodeURIComponent('midnight-kiln is the active theme')}`);
  assert.match(custom.body, /midnight-kiln is the active theme/);
});

test('S8x-1b. the picker reports what the browser is holding, not just "No file chosen"', async () => {
  const page = await screen();
  assert.equal(page.status, 200);
  // Our own status line, driven by the input's own files: the native label lives in the browser's
  // shadow DOM and says the same thing before and after a picker that handed nothing back.
  assert.match(page.body, /id="theme-picked"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(page.body, /data-skw-upload/);
  // No `accept` filter at all: the OS open panel enforces it, and a panel that refuses a file
  // closes with an empty selection and no message. The server decides by name and says why.
  assert.doesNotMatch(page.body, /id="theme-file"[^>]*accept=/, 'the picker is not a second opinion about what a theme may be');
  assert.match(page.body, /id="theme-upload" disabled/, 'Upload is dead until there is a file');
  assert.match(page.body, new RegExp('<script src="/admin/t/acme/themes/pick\.js" defer></script>'));

  // The script is served, not inline: the admin policy is script-src self + nonce.
  const js = await call({ port, path: '/admin/t/acme/themes/pick.js', host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(js.status, 200);
  assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(js.headers['cache-control'], 'no-store');
  assert.match(js.body, /addEventListener\('change'/);
  assert.match(js.body, /ready to upload/);
  assert.match(js.body, /handed back no file/, 'a picker that returns nothing is named, not shrugged at');
  // The drop path is not decoration: it is the way out when the panel refuses a file it can read.
  assert.match(js.body, /addEventListener\('drop'/);
  assert.match(js.body, /new DataTransfer\(\)/);
  assert.match(page.body, /drag the file onto this card/);
});

test('S8x-2. a zip package stores its own files and rewrites the sheet to point at them', async () => {
  const bundle = zipOf([
    { name: 'theme.css', bytes: Buffer.from(SHEET, 'utf8') },
    { name: 'assets/hero.svg', bytes: HERO },
  ]);
  const res = await upload('kiln.zip', bundle, { name: 'Kiln' });
  assert.equal(res.status, 303, res.body);
  assert.match(String(res.headers.location), /\?result=uploaded$/);

  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    const theme = db
      .prepare(`SELECT id, theme_key, css_sha256 FROM cms_theme WHERE name = 'Kiln'`)
      .get() as { id: number; theme_key: string; css_sha256: string } | undefined;
    assert.ok(theme !== undefined, 'the theme row exists');
    const asset = db
      .prepare(`SELECT path, sha256, bytes, content_type FROM cms_theme_asset WHERE theme_id = ?`)
      .get(theme.id) as { path: string; sha256: string; bytes: number; content_type: string } | undefined;
    assert.ok(asset !== undefined, 'the asset row exists');
    assert.equal(asset.path, 'assets/hero.svg');
    assert.equal(asset.content_type, 'image/svg+xml');
    assert.equal(asset.bytes, HERO.length);

    const sheet = db.prepare(`SELECT css FROM cms_css_blob WHERE sha256 = ?`).get(theme.css_sha256) as { css: string };
    assert.match(
      sheet.css,
      new RegExp(`body\\{background:url\\("/_theme/${theme.theme_key}/assets/hero\\.svg\\?v=[0-9a-f]{8}"\\)\\}`),
      'the relative url() became the absolute, versioned URL the browser will fetch',
    );

    // The bytes are on disk, beside the tenant's database, under the theme's own key.
    const file = `${themeAssetsRoot(fixture.dir, 'acme')}/${theme.theme_key}/assets/hero.svg`;
    assert.ok(existsSync(file), `the package's file was written (${file})`);
    assert.deepEqual(readFileSync(file), HERO);
  } finally {
    db.close();
  }
});

test('S8x-3. the asset URL serves the bytes, immutably, and only for a row that exists', async () => {
  const db = openAdminWrite(fixture.sitePath('acme'));
  let key = '';
  let sha = '';
  try {
    const row = db
      .prepare(
        `SELECT t.theme_key AS key, a.sha256 AS sha FROM cms_theme t
           JOIN cms_theme_asset a ON a.theme_id = t.id WHERE a.path = 'assets/hero.svg' AND t.name = 'Kiln'`,
      )
      .get() as { key: string; sha: string } | undefined;
    assert.ok(row !== undefined);
    key = row.key;
    sha = row.sha;
  } finally {
    db.close();
  }

  const asset = await call({ port, path: `/_theme/${key}/assets/hero.svg?v=${sha.slice(0, 8)}`, host: ADMIN_HOST });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers['content-type'], 'image/svg+xml');
  assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(asset.headers['x-content-type-options'], 'nosniff');
  // An SVG is also a document the browser will execute; this is the tenant's origin, so the
  // response carries a policy that allows it to be a picture and nothing else.
  assert.match(String(asset.headers['content-security-policy']), /default-src 'none'/);
  assert.deepEqual(asset.bytes, HERO);

  const missing = await call({ port, path: `/_theme/${key}/assets/nope.svg`, host: ADMIN_HOST });
  assert.equal(missing.status, 404, 'a path no row names is not a file');
  const escape = await call({ port, path: `/_theme/${key}/..%2f..%2fcontrol.db`, host: ADMIN_HOST });
  assert.equal(escape.status, 404, 'a traversal is a path no row names');
});

test('S8x-4. a deflated member inflates, and a corrupt member is refused rather than served', async () => {
  const bundle = zipOf([
    { name: 'theme.css', bytes: Buffer.from('.deflated{color:#010101}\n', 'utf8'), deflate: true },
    { name: 'assets/hero.svg', bytes: HERO, deflate: true },
  ]);
  const res = await upload('deflated.zip', bundle, { name: 'Deflated' });
  assert.equal(res.status, 303, res.body);
  assert.match(String(res.headers.location), /\?result=uploaded$/, 'deflate is the normal zip member and must work');

  const broken = zipOf([{ name: 'theme.css', bytes: Buffer.from('.a{color:red}', 'utf8') }, { name: 'assets/hero.svg', bytes: HERO }]);
  // Flip a byte of the stored SVG: the CRC no longer matches what the member claims.
  broken[broken.length - 22 - 46 - 'assets/hero.svg'.length - HERO.length + 2] = (broken[broken.length - 22 - 46 - 'assets/hero.svg'.length - HERO.length + 2] ?? 0) ^ 0xff;
  const refused = await upload('broken.zip', broken, { name: 'Broken' });
  assert.equal(refused.status, 303);
  assert.match(String(refused.headers.location), /does%20not%20match%20its%20checksum/);
});

test('S8x-5. what a package may not carry, said by name', async () => {
  const traversal = await upload(
    'escape.zip',
    zipOf([{ name: 'theme.css', bytes: Buffer.from('.a{color:red}', 'utf8') }, { name: '../evil.svg', bytes: HERO }]),
  );
  assert.match(String(traversal.headers.location), /escapes%20the%20package/);

  const script = await upload(
    'script.zip',
    zipOf([{ name: 'theme.css', bytes: Buffer.from('.a{color:red}', 'utf8') }, { name: 'assets/app.js', bytes: Buffer.from('alert(1)') }]),
  );
  assert.match(
    decodeURIComponent(String(script.headers.location)),
    /is not something a theme may carry/,
    'a theme holds pictures, fonts and stylesheets — not a second site under its own URL',
  );

  const noSheet = await upload('nosheet.zip', zipOf([{ name: 'assets/hero.svg', bytes: HERO }]));
  assert.match(decodeURIComponent(String(noSheet.headers.location)), /no stylesheet at its root/);

  const notAZip = await upload('fake.zip', Buffer.from('PK\u0003\u0004 not really a zip, honest', 'utf8'));
  assert.match(decodeURIComponent(String(notAZip.headers.location)), /not a zip|central directory/);
});

test('S8x-6. deleting a theme takes its files with it', async () => {
  const db = openAdminWrite(fixture.sitePath('acme'));
  let key = '';
  try {
    const row = db.prepare(`SELECT theme_key FROM cms_theme WHERE name = 'Deflated'`).get() as { theme_key: string } | undefined;
    assert.ok(row !== undefined);
    key = row.theme_key;
    assert.ok(existsSync(`${themeAssetsRoot(fixture.dir, 'acme')}/${key}`), 'the files are there before the delete');
  } finally {
    db.close();
  }

  const res = await call({
    port,
    path: '/admin/t/acme/themes/delete',
    method: 'POST',
    host: ADMIN_HOST,
    headers: { origin: ADMIN_ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie },
    body: new URLSearchParams({ theme: key, csrf: session.csrfToken }).toString(),
  });
  assert.equal(res.status, 303);
  assert.match(String(res.headers.location), /\?result=deleted$/);

  const check = openAdminWrite(fixture.sitePath('acme'));
  try {
    assert.equal((check.prepare(`SELECT COUNT(*) AS n FROM cms_theme WHERE theme_key = ?`).get(key) as { n: number }).n, 0);
  } finally {
    check.close();
  }
  assert.equal(existsSync(`${themeAssetsRoot(fixture.dir, 'acme')}/${key}`), false, 'the directory is gone with the row');
});

test('S8x-7. the reader refuses what the format cannot promise', () => {
  // A zip64 end record is a shape this reader does not implement; naming it beats mis-parsing it.
  const zip64 = zipOf([{ name: 'theme.css', bytes: Buffer.from('.a{color:red}', 'utf8') }]);
  zip64.writeUInt32LE(0xffff_ffff, zip64.length - 6);
  assert.throws(() => readZip(zip64), /zip64/);

  const empty = zipOf([]);
  assert.deepEqual(readZip(empty), [], 'an archive with no members is empty, not an error');

  // `__MACOSX` resource forks and `._` files are macOS bookkeeping, not theme content.
  const mac = zipOf([
    { name: 'theme.css', bytes: Buffer.from('.a{color:red}', 'utf8') },
    { name: '__MACOSX/._theme.css', bytes: Buffer.from('junk') },
    { name: '._assets', bytes: Buffer.from('junk') },
  ]);
  assert.deepEqual(readZip(mac).map((entry) => entry.path), ['theme.css']);
});

/**
 * The one package this repository ships. A theme is data, so nothing type-checks it and no route
 * test would notice a picture that the sheet names and the folder does not hold — that package
 * would upload cleanly and then 404 in a browser. This reads the sources off disk, packs them the
 * way an operator's `zip` would, and runs the same reader the upload route runs.
 */
test('S8x-8. the shipped Letterpress package carries every file its sheet names', async () => {
  const dir = new URL('../themes/letterpress/', import.meta.url).pathname;
  const members: Member[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    // Finder writes `.DS_Store` into any folder it opens, and `zip -r` includes it. The reader
    // refuses that name on purpose; an operator's build excludes it, and so does this packing step.
    if (entry.name === '.DS_Store' || entry.name.startsWith('._') || entry.parentPath.includes('__MACOSX')) continue;
    const path = relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/');
    members.push({ name: path, bytes: readFileSync(join(entry.parentPath, entry.name)) });
  }
  const bundle = readThemeBundle({ filename: 'letterpress.zip', bytes: zipOf(members) });

  assert.equal(bundle.name, 'Letterpress', 'theme.json names it');
  assert.ok(bundle.assets.length >= 6, `a package with pictures holds them; found ${bundle.assets.length}`);
  assert.match(bundle.css, /^\/\*/m, 'the sheet is documented like the rest of the repository');
  assert.doesNotMatch(bundle.css, /<script|<\/style/i, 'a stylesheet cannot carry markup');

  const named = [...bundle.css.matchAll(/url\(\s*['"]?(assets\/[^'")]+)/g)].map((m) => m[1] as string);
  assert.ok(named.length >= 5, 'the sheet names the package files');
  const carried = new Set(bundle.assets.map((asset) => asset.path));
  for (const path of named) assert.ok(carried.has(path), `${path} is named by the sheet and carried by the package`);

  const rewritten = rewriteAssetUrls(bundle.css, 'letterpress', bundle.assets);
  const absolute = [...rewritten.matchAll(/url\("(\/_theme\/[^"]+)"\)/g)].map((m) => m[1] as string);
  assert.equal(absolute.length, named.length, 'every relative reference became an absolute one');
  for (const url of absolute) assert.match(String(url), /^\/_theme\/letterpress\/assets\/[a-z0-9-]+\.(?:jpg|png|svg)\?v=[0-9a-f]{8}$/);
  assert.equal(/(['"]?)url\(\s*assets\//.test(rewritten), false, 'nothing relative survives the rewrite');
});
