/**
 * The edge config (SDS §5.2, §12.3). Two things are asserted here that no
 * runtime test can reach without a real nginx: the include discipline
 * (count(location-with-proxy_pass) == count(skunk-proxy include)) and the fact
 * that the generated file is the file in the repo.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseAdminAllowlist } from '../app/admin/allowlist.ts';
import { generateAppConf, main, parseAllowlistForGenerator, readHosts, tenantRate } from '../tools/nginx_gen.ts';
import { REPO, makeFixture } from './helpers/fixture.ts';

const fixture = makeFixture();
const generated = generateAppConf(readHosts(fixture.controlDb), {
  adminHost: 'admin.skw.test',
  demosHost: 'demos.skw.test',
  boxRps: 192,
});

/** Every `location ... { ... }` block in the text, with balanced braces and quotes respected. */
export function locationBlocks(text: string): string[] {
  const blocks: string[] = [];
  let start = -1;
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') inQuote = !inQuote;
    if (inQuote) continue;
    if (start === -1) {
      // A location directive begins at `location`; its block opens at the next `{`.
      if (text.startsWith('location', i) && (i === 0 || /[\s;{}]/.test(text[i - 1] as string))) {
        start = i;
        depth = 0;
      }
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        blocks.push(text.slice(start, i + 1));
        start = -1;
      }
    } else if (ch === ';' && depth === 0) {
      // `location /media/ { ... }` has no `;` before its block; a stray `location`
      // keyword outside a block would end here.
      start = -1;
    }
  }
  return blocks;
}

test('every location with proxy_pass includes the snippet, and no other does', () => {
  const blocks = locationBlocks(generated);
  const proxying = blocks.filter((b) => b.includes('proxy_pass'));
  const including = blocks.filter((b) => b.includes('include /etc/nginx/snippets/skunk-proxy.conf;'));
  assert.ok(proxying.length >= 4, `expected several proxying locations, got ${proxying.length}`);
  assert.equal(proxying.length, including.length);
  for (const block of proxying) {
    assert.match(block, /include \/etc\/nginx\/snippets\/skunk-proxy\.conf;/, block.slice(0, 120));
  }
  for (const block of including) {
    assert.match(block, /proxy_pass/, 'the snippet is included outside a proxy_pass location');
  }
  assert.doesNotMatch(generated, /return 404;\s*\n\s*\}\s*\n\s*server/, 'a 404 in server scope');
});

test('the demo location rewrites, then overrides exactly the two tenant lines', () => {
  const demo = locationBlocks(generated).find((b) => b.includes('$demo_key') && b.includes('proxy_pass'));
  assert.ok(demo !== undefined, 'no demo location');
  // Quoted: an unquoted `{0,31}` is a block delimiter to nginx's tokenizer.
  assert.match(demo, /location ~ "\^\/demo\//);
  // 40 characters, the same maximum as `tenant.key`'s CHECK (E-5).
  assert.match(demo, /rewrite "\^\/demo\/\[a-z0-9\]\[a-z0-9-\]\{0,39\}\/\(\.\*\)\$" \/\$1 break;/);
  assert.match(demo, /include \/etc\/nginx\/snippets\/skunk-proxy\.conf;/);
  assert.match(demo, /proxy_set_header X-Skunkworks-Tenant \$demo_key;/);
  assert.match(demo, /proxy_set_header X-Forwarded-Prefix "\/demo\/\$demo_key";/);
  assert.ok(
    demo.indexOf('include /etc/nginx/snippets/skunk-proxy.conf;') < demo.indexOf('X-Skunkworks-Tenant $demo_key'),
    'the overrides must come after the include',
  );
});

test('the slash-less demo form 301s to the slash form', () => {
  assert.match(generated, /return 301 \/demo\/\$demo_key\/\$is_args\$args;/);
  // The slash-less location must come before the proxying one, or it never wins.
  const slashless = generated.indexOf('return 301 /demo/$demo_key/$is_args$args;');
  const proxy = generated.indexOf('proxy_set_header X-Forwarded-Prefix "/demo/$demo_key";');
  assert.ok(slashless !== -1 && proxy !== -1 && slashless < proxy, 'the 301 must be the first demo location');
});

test('E-5 — every location regex is quoted, so no unquoted `{` can be read as a block', () => {
  for (const line of generated.split('\n')) {
    if (!/^\s*location\s/.test(line)) continue;
    const brace = line.indexOf('{');
    assert.ok(brace !== -1, `location line without a block: ${line}`);
    const pattern = line.slice(0, brace).replace(/\^~/, '');
    // `^~` is a prefix modifier, not a regex: it takes a literal path and needs no quotes.
    // A regex location (`~` or `~*`) does, because `{0,39}` in a bare pattern is a block
    // delimiter to nginx's tokenizer (E-5).
    if (/~\*?\s/.test(pattern)) {
      assert.match(pattern, /~\*?\s*"/, `an unquoted regex in: ${line.trim()}`);
    }
    // The only unquoted `{` on a location line is the block opener itself.
    assert.equal(line.slice(0, brace).includes('{'), false, `unquoted { before the block opener: ${line.trim()}`);
  }
});

/** The `server { ... }` block whose `server_name` names `host`. */
function serverBlock(text: string, host: string): string {
  const at = text.indexOf(`server_name ${host};`);
  if (at === -1) return '';
  const start = text.lastIndexOf('server {', at);
  const end = text.indexOf('\n}', at);
  return text.slice(start, end === -1 ? undefined : end + 2);
}

test('S4e / §12.5 — every tenant block listens on 443 and names its own certificate; the state is a comment', () => {
  const withPending = generateAppConf(
    [
      { host: 'pending.test', key: 'pending', cert_state: 'none' },
      { host: 'issued.test', key: 'issued', cert_state: 'issued' },
    ],
    { adminHost: 'admin.skw.test', demosHost: 'demos.skw.test', boxRps: 192 },
  );
  // S4e: install.sh mints a self-signed pair for every host before nginx starts, so a 443
  // block is safe for a pending host too — and a bundle exported from a tenant that had TLS
  // no longer ships a claim no file backs. The listener is uniform; the *state* is the fact a
  // reader needs, and it is a comment beside the block.
  const pendingBlock = serverBlock(withPending, 'pending.test');
  assert.notEqual(pendingBlock, '');
  assert.match(pendingBlock, /listen 80; listen 443 ssl;/);
  assert.match(pendingBlock, /ssl_certificate     \/etc\/nginx\/certs\/pending\.test\.crt;/);
  assert.match(pendingBlock, /ssl_certificate_key \/etc\/nginx\/certs\/pending\.test\.key;/);
  assert.match(withPending, /# tenant pending\n# certificate: pending \(self-signed until ACME\)/);
  const issuedBlock = serverBlock(withPending, 'issued.test');
  assert.match(issuedBlock, /listen 80; listen 443 ssl;/);
  assert.match(withPending, /# tenant issued\n# certificate: issued/);
  // The http-01 webroot is in every tenant block, and it cannot be shadowed by a regex.
  assert.match(pendingBlock, /location \^~ \/\.well-known\/acme-challenge\/ \{/);
  assert.match(pendingBlock, /root \/srv\/acme;/);
});

test('the map carries every host of every tenant, and no default tenant', () => {
  assert.match(generated, /map \$host \$tenant \{/);
  assert.match(generated, /hostnames;/);
  assert.match(generated, /default "";/);
  for (const spec of fixture.specs) {
    for (const host of spec.hosts) {
      assert.match(generated, new RegExp(`^    ${host.replace(/\./g, '\\.')} ${spec.key};$`, 'm'));
    }
  }
});

test('the admin vhost is one hostname with no demo location and no /media/', () => {
  const admin = generated.slice(generated.indexOf('server_name admin.skw.test'));
  assert.match(admin, /include \/etc\/nginx\/snippets\/skunk-proxy\.conf;/);
  assert.doesNotMatch(admin, /\$demo_key/);
  assert.doesNotMatch(admin, /location \/media\//);
});

test('the demos vhost 404s everything outside /demo/', () => {
  const demos = generated.slice(generated.indexOf('server_name demos.skw.test'), generated.indexOf('server_name admin.skw.test'));
  assert.match(demos, /location \/ \{ return 404; \}/);
});

test('the rate is derived, not the fixed 20r/s (§12.3: 3 tenants at 192 rps -> 20r/s burst 40)', () => {
  assert.deepEqual(tenantRate(192, 3), { rate: 20, burst: 40 });
  assert.deepEqual(tenantRate(192, 50), { rate: 3, burst: 6 });
  assert.match(generated, /limit_req_zone \$tenant zone=tenant:10m rate=20r\/s;/);
  assert.match(generated, /limit_req zone=tenant burst=40 nodelay;/);
});

test('the generator refuses a domain that collides with the demos or admin vhost', () => {
  const rows = [
    { host: 'acme.test', key: 'acme' },
    { host: 'demos.skw.test', key: 'demo-x' },
  ];
  assert.throws(
    () => generateAppConf(rows, { adminHost: 'admin.skw.test', demosHost: 'demos.skw.test', boxRps: 192 }),
    /demos vhost and cannot also be a domain of tenant demo-x/,
  );
  assert.throws(
    () =>
      generateAppConf([{ host: 'admin.skw.test', key: 'acme' }], {
        adminHost: 'admin.skw.test',
        demosHost: 'demos.skw.test',
        boxRps: 192,
      }),
    /admin vhost and cannot also be a domain of tenant acme/,
  );
});

test('the committed nginx/conf.d/10-app.conf is the generator output for this fixture', () => {
  const committed = readFileSync(join(REPO, 'nginx', 'conf.d', '10-app.conf'), 'utf8');
  assert.equal(committed, generated, 'regenerate: node dist/tools/nginx_gen.js --data-dir … --out nginx/conf.d/10-app.conf');
});

test('the snippet is the frozen one: empty tenant header, edge token placeholder', () => {
  const snippet = readFileSync(join(REPO, 'snippets', 'skunk-proxy.conf'), 'utf8');
  assert.match(snippet, /proxy_set_header X-Skunkworks-Tenant "";/);
  assert.match(snippet, /proxy_set_header X-Skunkworks-Edge {2}"__SKW_EDGE_TOKEN__";/);
  assert.match(snippet, /proxy_next_upstream {3}off;/);
});

// --- E-17: the allowlist is emitted in the admin block, and nowhere else ---

test('E-17: with the list empty the admin block emits neither allow nor deny, and no block does', () => {
  assert.doesNotMatch(generated, /^\s*allow\s/m, 'an empty allowlist must not emit an access directive');
  assert.doesNotMatch(generated, /^\s*deny\s/m, 'an empty allowlist must never become an accidental deny all');
  // The whole file, not only the admin block: §9.1a says the admin block and no other.
  assert.equal(generated.includes('deny'), false, 'the string `deny` must not appear in 10-app.conf at all');
});

test('E-17: a populated list emits one `allow` per block plus `deny all;` in the admin block only', () => {
  const withList = generateAppConf(readHosts(fixture.controlDb), {
    adminHost: 'admin.skw.test',
    demosHost: 'demos.skw.test',
    adminAllowlist: parseAdminAllowlist('203.0.113.0/24, 2001:db8::/32'),
  });
  const admin = serverBlock(withList, 'admin.skw.test');
  assert.match(admin, /^ {4}allow 203\.0\.113\.0\/24;$/m);
  assert.match(admin, /^ {4}allow 2001:db8::\/32;$/m);
  assert.match(admin, /^ {4}deny {2}all;$/m);
  // Order: allow lines, then the deny, and both before the first location.
  const firstAllow = admin.indexOf('allow 203.0.113.0/24;');
  const deny = admin.indexOf('deny  all;');
  const location = admin.indexOf('location /');
  assert.ok(firstAllow !== -1 && deny !== -1 && firstAllow < deny && deny < location, admin);

  // No tenant block and no demos block carries either directive, ever.
  for (const spec of fixture.specs) {
    if (spec.corrupt === true) continue;
    const host = spec.hosts[0] as string;
    const block = serverBlock(withList, host);
    assert.doesNotMatch(block, /^\s*(allow|deny)\s/m, `tenant ${spec.key} carries an access directive`);
  }
  assert.doesNotMatch(serverBlock(withList, 'demos.skw.test'), /^\s*(allow|deny)\s/m);
});

test('E-17: the admin and demos hosts are derived from SKW_ADMIN_ORIGIN, and the old env names are gone', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'skw-nginxd-'));
  const out = join(tmp, '10-app.conf');
  const saved = { origin: process.env.SKW_ADMIN_ORIGIN, admin: process.env.SKW_ADMIN_HOST, demos: process.env.SKW_DEMOS_HOST };
  try {
    process.env.SKW_ADMIN_ORIGIN = 'https://admin.cms.example.com';
    // The deleted names are read by nothing; setting them must change nothing.
    process.env.SKW_ADMIN_HOST = 'wrong.example';
    process.env.SKW_DEMOS_HOST = 'also-wrong.example';
    assert.equal(main(['--data-dir', fixture.dir, '--out', out]), 0);
    const text = readFileSync(out, 'utf8');
    assert.match(text, /server_name admin\.cms\.example\.com;/);
    assert.match(text, /server_name demos\.cms\.example\.com;/, 'demos is admin with its first label replaced');
    assert.doesNotMatch(text, /wrong\.example/, 'SKW_ADMIN_HOST/SKW_DEMOS_HOST are deleted, not read');
  } finally {
    for (const [key, value] of Object.entries({ SKW_ADMIN_ORIGIN: saved.origin, SKW_ADMIN_HOST: saved.admin, SKW_DEMOS_HOST: saved.demos })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('E-17: the generator refuses a malformed allowlist from the same parser, with the same message', () => {
  let parserMessage = '';
  try {
    parseAdminAllowlist('10.0.0.0/33');
  } catch (err) {
    parserMessage = (err as Error).message;
  }
  assert.match(parserMessage, /SKW_ADMIN_ALLOWLIST/);
  assert.throws(
    () => parseAllowlistForGenerator('10.0.0.0/33'),
    (err: unknown) => (err as Error).message === parserMessage,
    'the edge and the app must give one answer to "is this value usable"',
  );
});
