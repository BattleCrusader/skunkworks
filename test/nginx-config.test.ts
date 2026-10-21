/**
 * The edge config (SDS §5.2, §12.3). Two things are asserted here that no
 * runtime test can reach without a real nginx: the include discipline
 * (count(location-with-proxy_pass) == count(skunk-proxy include)) and the fact
 * that the generated file is the file in the repo.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseAdminAllowlist } from '../app/admin/allowlist.ts';
import { generateAppConf, main, parseAllowlistForGenerator, readHosts, tenantRate } from '../tools/nginx_gen.ts';
import { REPO, makeFixture } from './helpers/fixture.ts';

const fixture = makeFixture();
const generated = generateAppConf(readHosts(fixture.controlDb), {
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

/**
 * The `server { ... }` block whose `server_name` names `host`.
 *
 * `host` is a token in a possibly multi-host line (`server_name acme.test
 * www.acme.test;`), so the match is by line and token rather than by exact text —
 * which is what made this helper return '' for every tenant with an alias.
 */
function serverBlock(text: string, host: string): string {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('server_name ')) return false;
    const names = trimmed.slice('server_name '.length).replace(/;\s*$/, '').split(/\s+/);
    return names.includes(host);
  });
  if (at === -1) return '';
  let start = at;
  while (start >= 0 && lines[start] !== 'server {') start -= 1;
  if (start < 0) return '';
  let end = at;
  while (end < lines.length && lines[end] !== '}') end += 1;
  return lines.slice(start, end + 1).join('\n');
}

test('S4e / §12.5 — every tenant block listens on 443 and names its own certificate; the state is a comment', () => {
  const withPending = generateAppConf(
    [
      { host: 'pending.test', key: 'pending', cert_state: 'none' },
      { host: 'issued.test', key: 'issued', cert_state: 'issued' },
    ],
    { demosHost: 'demos.skw.test', boxRps: 192 },
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

test('D37 — /admin is a location inside every tenant block, and there is no admin vhost', () => {
  // This test replaces "the admin vhost is one hostname with no demo location and no
  // /media/". D37 moved the admin surface onto each tenant's own host, so the thing to
  // assert is now the opposite shape: the vhost is gone, and every tenant block has the
  // location that serves it.
  assert.equal(generated.includes('server_name admin.skw.test'), false, 'no admin vhost is emitted');
  assert.equal(generated.includes('/etc/nginx/certs/default.crt'), true, 'the demos vhost still needs a pair');
  assert.equal(
    (generated.match(/default\.crt/g) ?? []).length,
    1,
    'the default certificate pair belongs to the demos vhost alone now',
  );

  for (const spec of fixture.specs) {
    if (spec.corrupt === true) continue;
    for (const host of spec.hosts) {
      const block = serverBlock(generated, host);
      assert.notEqual(block, '', `no block for ${host}`);
      assert.match(block, /location ~ "\^\/admin\(\/\|\$\)" \{/, `tenant ${spec.key} (${host}) does not serve /admin`);
      assert.match(block, /include \/etc\/nginx\/snippets\/skunk-proxy\.conf;/, `tenant ${spec.key} does not proxy`);
      // The rate limit is repeated in the admin location on purpose: nginx does not
      // inherit `limit_req` into a nested location, so without this line the admin
      // would be the one unmetered surface on the box.
      assert.equal(
        (block.match(/limit_req zone=tenant/g) ?? []).length,
        2,
        `tenant ${spec.key}: location / and location /admin are both metered`,
      );
    }
  }
});
test('the demos vhost 404s everything outside /demo/', () => {
  // D37: the demos block is the last one in the file — the admin vhost that used to
  // follow it is gone, so the slice runs to the end.
  const demos = generated.slice(generated.indexOf('server_name demos.skw.test'));
  assert.match(demos, /location \/ \{ return 404; \}/);
});

test('the rate is derived, not the fixed 20r/s (§12.3: 3 tenants at 192 rps -> 20r/s burst 40)', () => {
  assert.deepEqual(tenantRate(192, 3), { rate: 20, burst: 40 });
  assert.deepEqual(tenantRate(192, 50), { rate: 3, burst: 6 });
  assert.match(generated, /limit_req_zone \$tenant zone=tenant:10m rate=20r\/s;/);
  assert.match(generated, /limit_req zone=tenant burst=40 nodelay;/);
});

test('the generator refuses the demos name — and admin.<domain> is an ordinary host now (D37)', () => {
  const rows = [
    { host: 'acme.test', key: 'acme' },
    { host: 'demos.skw.test', key: 'demo-x' },
  ];
  assert.throws(
    () => generateAppConf(rows, { demosHost: 'demos.skw.test', boxRps: 192 }),
    /demos vhost and cannot also be a domain of tenant demo-x/,
  );
  // D37 supersedes the second half of this test. `admin.<domain>` was a vhost and
  // therefore a reserved name; there is no admin vhost, so the name is an ordinary
  // hostname a tenant may claim. What must NOT happen is an admin block appearing:
  // a `server_name admin.skw.test` emitted *as its own server* would be the old
  // promise back in the file.
  const withAdminName = generateAppConf([{ host: 'admin.skw.test', key: 'acme' }], {
    demosHost: 'demos.skw.test',
    boxRps: 192,
  });
  assert.match(withAdminName, /server_name admin\.skw\.test;/m, 'the name is a tenant host now');
  assert.equal((withAdminName.match(/\nserver \{/g) ?? []).length, 2, 'one tenant block plus the demos block');
  assert.doesNotMatch(withAdminName, /admin: the only host that serves/, 'the admin vhost comment is gone');
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

// --- E-17: the allowlist is emitted inside every tenant block's /admin location, and nowhere else ---

test('E-17: with the list empty no block emits an access directive', () => {
  assert.doesNotMatch(generated, /^\s*allow\s/m, 'an empty allowlist must not emit an access directive');
  assert.doesNotMatch(generated, /^\s*deny\s/m, 'an empty allowlist must never become an accidental deny all');
  // The whole file, not only the admin locations: §9.1a says the admin and no other path.
  assert.equal(generated.includes('deny'), false, 'the string `deny` must not appear in 10-app.conf at all');
});

test('E-17 + D37: a populated list is emitted on /admin in every tenant block, and on no other path', () => {
  const withList = generateAppConf(readHosts(fixture.controlDb), {
    demosHost: 'demos.skw.test',
    adminAllowlist: parseAdminAllowlist('203.0.113.0/24, 2001:db8::/32'),
  });

  const tenants = fixture.specs.filter((spec) => spec.corrupt !== true);
  for (const spec of tenants) {
    const block = serverBlock(withList, spec.hosts[0] as string);
    assert.notEqual(block, '', `no block for ${spec.hosts[0]}`);
    // The directives are inside the admin location, not at server scope: at server
    // scope they would refuse a peer the whole site, which is not what the list means.
    const adminStart = block.indexOf('location ~ "^/admin(/|$)" {');
    assert.notEqual(adminStart, -1, `tenant ${spec.key} has no /admin location`);
    const adminLocation = block.slice(adminStart, block.indexOf('}', block.indexOf('proxy_pass', adminStart)));
    assert.match(adminLocation, /^ {8}allow 203\.0\.113\.0\/24;$/m, `tenant ${spec.key}`);
    assert.match(adminLocation, /^ {8}allow 2001:db8::\/32;$/m, `tenant ${spec.key}`);
    assert.match(adminLocation, /^ {8}deny {2}all;$/m, `tenant ${spec.key}`);
    // Order: allow lines, then the deny, and both before the proxy.
    const firstAllow = adminLocation.indexOf('allow 203.0.113.0/24;');
    const deny = adminLocation.indexOf('deny  all;');
    const proxy = adminLocation.indexOf('proxy_pass');
    assert.ok(firstAllow !== -1 && deny !== -1 && firstAllow < deny && deny < proxy, adminLocation);

    // And nowhere else in that block.
    const outsideAdmin = block.slice(0, adminStart) + block.slice(adminStart + adminLocation.length);
    assert.doesNotMatch(outsideAdmin, /^\s*(allow|deny)\s/m, `tenant ${spec.key} carries an access directive outside /admin`);
  }
  assert.doesNotMatch(serverBlock(withList, 'demos.skw.test'), /^\s*(allow|deny)\s/m, 'the demos vhost never carries one');
});

test('E-17 + D37: the demos host is derived from SKW_ADMIN_ORIGIN, and no admin vhost is emitted', () => {
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
    // D37: the admin hostname derives the *demos* host and nothing else. It is not a
    // vhost, so a generated config that named it as one would be the old promise back.
    assert.doesNotMatch(text, /server_name admin\.cms\.example\.com;/, 'no admin vhost is emitted');
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

/**
 * NG-8 (measured on a real install, 2026-10-21). The tracked `nginx/conf.d/10-app.conf`
 * is a TEST FIXTURE — `tools/regen_conf.ts` rewrites it from the gate's fixtures, so it
 * names acme.test, beta.test, broken.test, acme-demo.test and demos.skw.test. Shipping
 * that file to a real install is a dead site: nginx asks for
 * `/etc/nginx/certs/acme.test.crt` and crash-loops. Found by installing a seed with
 * abc123.com / demo.abc123.com / 123abc.com — every gate was green because every gate
 * used the fixture hosts.
 *
 * Two assertions, and the second is the one that matters: the generator follows whatever
 * is in control.db, and install.sh actually CALLS it. A fixed generator nobody invokes
 * is exactly the state that produced the dead site.
 */
test('NG-8: the config follows the installed hosts, and install.sh generates it before nginx starts', () => {
  const sh = readFileSync(join(REPO, 'install.sh'), 'utf8');
  assert.match(
    sh,
    /nginx_gen\.js/,
    'install.sh must generate nginx/conf.d/10-app.conf from the installed control.db — the tracked file is a test fixture',
  );

  const dir = mkdtempSync(join(tmpdir(), 'skw-ng8-'));
  try {
    const dbPath = join(dir, 'control.db');
    copyFileSync(fixture.controlDb, dbPath);
    // Rename EVERY domain the generator reads, so the assertion below cannot pass on a
    // leftover fixture host: the point is that no old name survives, not that one new
    // name appears beside the fixture's.
    const before = readHosts(dbPath).map((r) => r.host);
    assert.ok(before.length > 0, 'the fixture must have at least one host the generator emits');
    const db = new DatabaseSync(dbPath);
    try {
      const rename = db.prepare('UPDATE domain SET host = ? WHERE host = ?');
      before.forEach((host, i) => rename.run(`site${i}.example.org`, host));
    } finally {
      db.close();
    }

    const text = generateAppConf(readHosts(dbPath), {
      demosHost: 'demos.example.org',
      boxRps: 192,
    });

    // A tenant with several hosts gets ONE server block naming them all
    // (`server_name a b;`), so the assertion must not demand a semicolon right after the name.
    assert.match(
      text,
      /server_name[^;]*site0\.example\.org/,
      'the generated config must name the installed host',
    );
    for (const oldHost of before) {
      assert.ok(
        !text.includes(oldHost),
        `a host from before the install (${oldHost}) survived into the generated config — this is the dead-site bug`,
      );
    }
    assert.ok(
      text.includes('/etc/nginx/certs/site0.example.org.crt'),
      'the certificate path must be derived from the same host',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
