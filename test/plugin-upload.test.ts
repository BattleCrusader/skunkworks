/**
 * S8o — installing a plugin by uploading one file.
 *
 * `skwctl plugin install` needs a shell on the box. This is the same install, reached from the
 * Plugins screen: a `.tar.gz` in a multipart form, unpacked into a scratch directory, handed to
 * `installPlugin()` — the same function the CLI calls — and removed again.
 *
 * The tests are the refusals as much as the happy path, because an upload door is a place where
 * "it worked" is the least interesting outcome:
 *
 *   S8o-1  the archive format round-trips, and packing one tree twice gives one file
 *   S8o-2  a name that leaves the directory is refused, and nothing is written outside
 *   S8o-3  an upload without the acknowledgement installs nothing and says why
 *   S8o-4  an unsigned package without `allow-unsigned` is refused by name (SKW_E_PL_SIGNATURE)
 *   S8o-5  an unsigned package *with* the flag installs as `unsigned`, unenabled, and Enable
 *          then makes the package's own screen answer — the whole point of installing it
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import Database from 'better-sqlite3';

import { openAdminWrite } from '../app/db/classes.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { AppError } from '../app/errors.ts';
import { packPackage, readPackageArchive, unpackArchive, uploadScratchDir, removeScratchDir } from '../app/plugins/archive.ts';
import { packageRootHash } from '../app/plugins/manifest.ts';
import { installFromArchive } from '../app/plugins/upload.ts';
import { ADMIN_HOST, ADMIN_ORIGIN, TOTP_SECRET, openSession, seedUser, type Sessioned } from './helpers/admin.ts';
import { REPO, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, header, type Res } from './helpers/http.ts';

const CONTACT = join(REPO, 'plugins', 'contact');
const DIGEST = 'sha256:upload-gate';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let session: Sessioned;

/** A multipart body whose file field this test names, because the form's field is `package`. */
function multipart(fields: Record<string, string>, file: { name: string; type: string; bytes: Buffer }): { body: Buffer; contentType: string } {
  const boundary = '----skwupload' + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="package"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`),
  );
  chunks.push(file.bytes);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** A report bound to the package's own root, written **outside** the package (that is the rule). */
function reportFor(dir: string, plugin: string, name: string): string {
  const { root } = packageRootHash(dir);
  const path = join(fixture.dir, name);
  writeFileSync(
    path,
    `${JSON.stringify({ plugin, version: '1.0.0', root_hash: root, runner_image_digest: DIGEST, ran_at: new Date().toISOString() }, null, 2)}\n`,
  );
  return path;
}

async function upload(body: Buffer, contentType: string, opts: { csrf?: string | null } = {}): Promise<Res> {
  const headers: Record<string, string> = { origin: ADMIN_ORIGIN, 'content-type': contentType, cookie: session.cookie };
  if (opts.csrf !== null) headers['x-csrf-token'] = opts.csrf ?? session.csrfToken;
  return call({ port, path: '/admin/t/acme/plugins/upload', method: 'POST', host: ADMIN_HOST, headers, body });
}

function siteDb(): Database.Database {
  return openAdminWrite(fixture.sitePath('acme'));
}

function installedRow(plugin: string): { version: string; enabled: number; signature_state: string; test_report_sha: string } | undefined {
  const db = siteDb();
  try {
    return db
      .prepare('SELECT version, enabled, signature_state, test_report_sha FROM cms_plugin_installed WHERE plugin_id = ?')
      .get(plugin) as { version: string; enabled: number; signature_state: string; test_report_sha: string } | undefined;
  } finally {
    db.close();
  }
}

/** A tar with one entry whose name escapes the extraction directory, built by hand. */
function traversalArchive(name: string): Buffer {
  const header = Buffer.alloc(512, 0);
  const put = (offset: number, length: number, value: string): void => {
    header.write(value.slice(0, length - 1), offset, 'utf8');
  };
  const octal = (offset: number, length: number, value: number): void => {
    header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, 'utf8');
  };
  put(0, 100, name);
  octal(100, 8, 0o644);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, 4);
  octal(136, 12, 0);
  header.write('        ', 148, 'utf8');
  header.write('0', 156, 'utf8');
  header.write('ustar\0', 257, 'utf8');
  header.write('00', 263, 'utf8');
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
  octal(148, 8, sum);
  const data = Buffer.alloc(512, 0);
  data.write('evil', 0, 'utf8');
  return Buffer.concat([header, data, Buffer.alloc(1024, 0)]);
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: [ADMIN_HOST], title: 'Acme' }] });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'owner@acme.test', totpSecret: TOTP_SECRET });
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

test('S8o-1. a packed package unpacks to the same tree, and packing it twice gives one file', () => {
  const report = reportFor(CONTACT, 'contact', 'contact-report.json');
  const first = packPackage(CONTACT, { reportPath: report });
  const second = packPackage(CONTACT, { reportPath: report });
  assert.deepEqual(first, second, 'two packs of one tree must be byte-identical: the hash is the identity');

  const { entries } = readPackageArchive(first);
  const names = entries.map((entry) => entry.name).sort();
  assert.ok(names.includes('contact/plugin.json'), `missing the manifest: ${names.join(', ')}`);
  assert.ok(names.includes('test-report.json'), 'the report travels beside the package');

  const scratch = uploadScratchDir();
  try {
    const { root, reportPath } = unpackArchive(first, scratch);
    // The package root is the directory with plugin.json — one level down, because the archive
    // holds `contact/…` — and the report is its sibling, outside the tree the hash covers.
    assert.equal(root, join(scratch, 'contact'));
    assert.equal(reportPath, join(scratch, 'test-report.json'));
    assert.equal(readFileSync(join(root, 'plugin.json')).length > 0, true);
    assert.equal(existsSync(join(root, 'test-report.json')), false, 'a report inside the root would change the hash it attests');
  } finally {
    removeScratchDir(scratch);
  }
});

test('S8o-2. an entry that leaves the directory is refused, and nothing lands outside it', () => {
  const scratch = uploadScratchDir();
  try {
    assert.throws(
      () => unpackArchive(traversalArchive('../../escaped.txt'), scratch),
      (err: unknown) => err instanceof AppError && err.code === 'SKW_E_PL_ARCHIVE_FAILED',
      'a name with .. must be refused by name',
    );
    assert.equal(existsSync(join(scratch, '..', '..', 'escaped.txt')), false, 'nothing may be written outside the scratch directory');
    assert.deepEqual(readdirSync(scratch), [], 'the refusal must not leave a partial tree behind');
  } finally {
    removeScratchDir(scratch);
  }
});

test('S8o-3. an upload without the acknowledgement installs nothing, and says so', async () => {
  const report = reportFor(CONTACT, 'contact', 'contact-report.json');
  const archive = packPackage(CONTACT, { reportPath: report });
  const { body, contentType } = multipart({ csrf: session.csrfToken }, { name: 'contact.tar.gz', type: 'application/gzip', bytes: archive });
  const res = await upload(body, contentType);
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /Not installed/);
  assert.match(res.body, /acknowledgement box/);
  assert.equal(installedRow('contact'), undefined, 'a refused upload must not write the row');
});

test('S8o-4. an unsigned package without allow-unsigned is refused by its own code', async () => {
  const report = reportFor(CONTACT, 'contact', 'contact-report.json');
  const archive = packPackage(CONTACT, { reportPath: report });
  const { body, contentType } = multipart(
    { csrf: session.csrfToken, understand: '1' },
    { name: 'contact.tar.gz', type: 'application/gzip', bytes: archive },
  );
  const res = await upload(body, contentType);
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /SKW_E_PL_SIGNATURE/, 'the refusal names the code the CLI would have printed');
  assert.equal(installedRow('contact'), undefined);
});

test('S8o-5. an acknowledged unsigned upload installs, stays unenabled, and Enable runs it', async () => {
  const report = reportFor(CONTACT, 'contact', 'contact-report.json');
  const archive = packPackage(CONTACT, { reportPath: report });
  const { body, contentType } = multipart(
    { csrf: session.csrfToken, understand: '1', allow_unsigned: '1' },
    { name: 'contact.tar.gz', type: 'application/gzip', bytes: archive },
  );
  const res = await upload(body, contentType);
  assert.equal(res.status, 303, res.body);
  const location = String(header(res, 'location'));
  assert.match(location, /\/admin\/t\/acme\/plugins\?result=installed%20contact/);
  assert.match(decodeURIComponent(location), /self-attested/);
  assert.match(decodeURIComponent(location), /UNSIGNED/);

  const row = installedRow('contact');
  assert.ok(row !== undefined, 'the row must exist');
  assert.equal(row.enabled, 0, 'an upload is not an enable');
  assert.equal(row.signature_state, 'unsigned');
  assert.equal(row.test_report_sha.length, 64, 'the report the archive carried is recorded by hash');

  // The package's bytes are in the plugin root the runtime loads from, and only there.
  assert.equal(existsSync(join(fixture.dir, 'plugins', 'contact', 'plugin.json')), true);

  // Enable is the second press, and it makes the package's own screen answer.
  const enabled = await call({
    port,
    path: '/admin/t/acme/plugins/enable',
    method: 'POST',
    host: ADMIN_HOST,
    headers: { origin: ADMIN_ORIGIN, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'plugin=contact',
  });
  assert.equal(enabled.status, 303, enabled.body);

  const screen = await call({
    port,
    path: '/admin/t/acme/messages',
    method: 'GET',
    host: ADMIN_HOST,
    headers: { cookie: session.cookie },
  });
  assert.equal(screen.status, 200, screen.body);
  assert.match(screen.body, /p_contact_message|message/i);
});

test('S8o-6. installFromArchive refuses an archive with no report instead of installing blind', () => {
  const archive = packPackage(CONTACT);
  assert.throws(
    () =>
      installFromArchive({
        archive,
        siteDb: fixture.sitePath('acme'),
        pluginsRoot: join(fixture.dir, 'plugins'),
        allowUnsigned: true,
      }),
    (err: unknown) => err instanceof AppError && err.code === 'SKW_E_PL_TESTS_STALE',
    'no report, no install — the same refusal the CLI gives',
  );
});
