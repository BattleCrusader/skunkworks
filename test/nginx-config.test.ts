/**
 * The edge config (SDS §5.2, §12.3). Two things are asserted here that no
 * runtime test can reach without a real nginx: the include discipline
 * (count(location-with-proxy_pass) == count(skunk-proxy include)) and the fact
 * that the generated file is the file in the repo.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { generateAppConf, readHosts, tenantRate } from '../tools/nginx_gen.ts';
import { REPO, makeFixture } from './helpers/fixture.ts';

const fixture = makeFixture();
const generated = generateAppConf(readHosts(fixture.controlDb), {
  adminHost: 'admin.skw.test',
  demosHost: 'demos.skw.test',
  boxRps: 192,
});

/** Every `location ... { ... }` block in the text, with balanced braces. */
export function locationBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = /\blocation\b[^{]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = m.index;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      i += 1;
    }
    blocks.push(text.slice(start, i));
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
  const demo = locationBlocks(generated).find((b) => b.includes('$demo_key'));
  assert.ok(demo !== undefined, 'no demo location');
  // Quoted: an unquoted `{0,31}` is a block delimiter to nginx's tokenizer.
  assert.match(demo, /location ~ "\^\/demo\//);
  assert.match(demo, /rewrite "\^\/demo\/\[a-z0-9\]\[a-z0-9-\]\{0,31\}\/\(\.\*\)\$" \/\$1 break;/);
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

test('the admin vhost is one hostname with no demo location', () => {
  const admin = generated.slice(generated.indexOf('server_name admin.skw.test'));
  assert.match(admin, /include \/etc\/nginx\/snippets\/skunk-proxy\.conf;/);
  assert.doesNotMatch(admin, /\$demo_key/);
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
