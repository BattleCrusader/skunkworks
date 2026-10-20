/**
 * S4c item 4 — **the CSP is one policy, in four places, byte-identical** (§10.5, C-12;
 * §16 S4 "the CSP header is byte-identical in all three targets").
 *
 * Before this gate no target emitted a CSP header at all: the S4b report left the row
 * "not done — no target emits a CSP header yet" and named it S4c's job.
 *
 * The four places:
 *
 *   1. the **live site**: `Content-Security-Policy` on every `text/html` response (the
 *      tenant page and the admin form), and none on the JSON error surface — a JSON body
 *      has no scripts to constrain;
 *   2. the **static** tree: `security-headers.conf`;
 *   3. the **Astro** tree: the same file;
 *   4. the **CMS bundle**: `snippets/skunk-csp.conf`, included by the generated vhost in the
 *      locations nginx serves itself.
 *
 * The assertion is equality of **bytes**, not of meaning: the three files are the same file
 * (one `cspConf()` call, one sha256), and the live header's value is the same string. A
 * policy compared by eye drifts; a policy compared by hash cannot.
 *
 * The mutation proof is in `docs/build/S4c-report.md` §4: one character added inside a
 * directive in `cspPolicy()` reddens this file at three assertions and the export gates too.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { loadEnv } from '../app/env.ts';
import { runExport } from '../app/export/index.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { CSP_CONF_FILE, CSP_HEADER, cspConf, cspPolicy } from '../app/render/csp.ts';
import { REPO, SCHEMA, makeFixture, type Fixture } from '../test/helpers/fixture.ts';
import { call } from '../test/helpers/http.ts';

const NOW = '2026-10-20T12:00:00.000Z';
const POLICY = cspPolicy();

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
const trees: Record<'static' | 'astro' | 'cms', string> = { static: '', astro: '', cms: '' };

/** The one `Content-Security-Policy` line in a conf file, and its quoted value. */
function policyIn(text: string): { line: string; policy: string } {
  const lines = text.split('\n').filter((line) => /^\s*add_header Content-Security-Policy /.test(line));
  assert.equal(lines.length, 1, `expected exactly one CSP line, found ${lines.length}:\n${text}`);
  const match = /^add_header Content-Security-Policy "(.+)" always;$/.exec(lines[0] as string);
  assert.ok(match !== null, `not an \`add_header … always;\` line: ${String(lines[0])}`);
  return { line: lines[0] as string, policy: match[1] as string };
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
  const db = new Database(fixture.sitePath('acme'), { readonly: true });
  try {
    for (const target of ['static', 'astro', 'cms'] as const) {
      trees[target] = join(fixture.dir, `out-${target}`);
      const result = runExport({
        target,
        db,
        tenantKey: 'acme',
        out: trees[target],
        exportNow: NOW,
        contentRoot: join(fixture.dir, 'content'),
        repoRoot: REPO,
        tmpDir: fixture.dir,
        origin: 'https://acme.test',
        ...(target === 'cms'
          ? {
              tenant: {
                key: 'acme',
                mode: 'production' as const,
                status: 'active',
                displayName: 'Acme',
                dbVersion: 3,
                hosts: [{ host: 'acme.test', kind: 'primary', isPrimary: 1, certState: 'issued' }],
              },
            }
          : {}),
      });
      assert.equal(result.ok, true, `${target} refused: ${result.ok ? '' : JSON.stringify(result.refusals)}`);
    }
  } finally {
    db.close();
  }

  handle = await buildApp({ env: loadEnv(fixture.env), schemaDir: SCHEMA, contentRoot: join(fixture.dir, 'content') });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
});

after(async () => {
  if (handle !== undefined) await handle.close();
  if (fixture !== undefined) fixture.cleanup();
});

test('C1 — the live site sends the policy on a page, byte-identically', async () => {
  const res = await call({ port, path: '/pricing', host: 'acme.test' });
  assert.equal(res.status, 200);
  assert.equal(res.headers[CSP_HEADER], POLICY, 'the served document carries the policy');
});

test('C2 — every HTML surface carries it, and a JSON error carries none', async () => {
  // The admin login is a second HTML surface (D29: a plain form, no JavaScript).
  const login = await call({ port, path: '/admin/login', host: 'admin.skw.test' });
  assert.equal(login.status, 200);
  assert.equal(login.headers[CSP_HEADER], POLICY, 'the admin form carries the policy too');

  // And the negative half of the rule: a 404 from the public listener is the §4.3 JSON
  // error body, not a document, so a CSP on it would be a header with nothing to constrain.
  const missing = await call({ port, path: '/no-such-page', host: 'acme.test' });
  assert.equal(missing.status, 404);
  assert.match(String(missing.headers['content-type']), /application\/json/);
  assert.equal(missing.headers[CSP_HEADER], undefined);
});

test('C3 — the three trees ship one file, and its policy is the live one', () => {
  const files = {
    static: join(trees.static, CSP_CONF_FILE),
    astro: join(trees.astro, CSP_CONF_FILE),
    cms: join(trees.cms, 'snippets', 'skunk-csp.conf'),
  };
  const hashes = Object.fromEntries(
    Object.entries(files).map(([name, path]) => [name, createHash('sha256').update(readFileSync(path)).digest('hex')]),
  );
  assert.equal(new Set(Object.values(hashes)).size, 1, `the three files differ: ${JSON.stringify(hashes)}`);
  for (const [name, path] of Object.entries(files)) {
    const { policy } = policyIn(readFileSync(path, 'utf8'));
    assert.equal(policy, POLICY, `${name}: the policy is not the served one`);
  }
});

test('C4 — the checked-in repo snippet is the same bytes, so a policy change must be regenerated', () => {
  const repo = readFileSync(join(REPO, 'snippets', 'skunk-csp.conf'), 'utf8');
  assert.equal(repo, cspConf(), 'snippets/skunk-csp.conf is stale: regenerate it from app/render/csp.ts');
});

test('C5 — the generated vhost includes the snippet where nginx serves bytes itself', () => {
  const conf = readFileSync(join(trees.cms, 'nginx', 'conf.d', '10-app.conf'), 'utf8');
  assert.equal(
    (conf.match(/include \/etc\/nginx\/snippets\/skunk-csp\.conf;/g) ?? []).length,
    3,
    'the media and two protected locations include the snippet',
  );
  // And not at server scope: a proxied document already carries the header, and two
  // policies on one response is the thing "one policy" forbids.
  assert.equal(/(^|\n) {4}include \/etc\/nginx\/snippets\/skunk-csp\.conf;/.test(conf), false);
});

test('C6 — the same policy for both the static and the Astro tree, at the byte level', () => {
  const a = readFileSync(join(trees.static, CSP_CONF_FILE));
  const b = readFileSync(join(trees.astro, CSP_CONF_FILE));
  assert.equal(Buffer.compare(a, b), 0);
  assert.equal(a.toString('utf8'), cspConf());
});
