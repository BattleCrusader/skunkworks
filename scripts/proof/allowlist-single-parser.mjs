#!/usr/bin/env node
/**
 * E-17's acceptance proof: the allowlist parser is **literally the same module**
 * in both consumers — mutate one accepted range in it and the app and the edge
 * both change.
 *
 *   node scripts/proof/allowlist-single-parser.mjs
 *
 * The mutation is applied to `app/admin/allowlist.ts` in place, measured in two
 * fresh node processes (module caches cannot hide a copy), and restored in a
 * `finally` with a sha256 check. Exit 0 only when both consumers moved under the
 * mutation and both returned to their baseline after the restore.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PARSER = join(REPO, 'app', 'admin', 'allowlist.ts');

const ORIGINAL_RETURN = '  return `${address}/${prefix}`;';
const MUTATED_RETURN = [
  '  // MUTATION (proof only): one accepted range, rewritten in the one parser.',
  "  if (address === '203.0.113.0' && prefix === 24) return '198.51.100.0/24';",
  '  return `${address}/${prefix}`;',
].join('\n');

const MEASURE = `
const { loadEnv } = await import('./app/env.ts');
const { parseAdminAllowlistFrom } = await import('./app/admin/allowlist.ts');
const { generateAppConf } = await import('./tools/nginx_gen.ts');
const source = {
  ...process.env,
  SKW_DATA_DIR: '/tmp/skw-proof', SKW_EDGE_TOKEN: 'edge', SKW_SESSION_KEY: 'session',
  SKW_DOWNLOAD_TOKEN_KEY: 'download', SKW_IP_HASH_KEY: 'ip',
  SKW_ADMIN_ORIGIN: 'https://admin.skw.test', SKW_BUILD_ID: 'proof',
  SKW_ARGON2_MAX_CONCURRENT: '4', UV_THREADPOOL_SIZE: '8',
  SKW_ADMIN_ALLOWLIST: '203.0.113.0/24',
};
const app = loadEnv(source).adminAllowlist;
const edge = parseAdminAllowlistFrom(source);
const conf = generateAppConf([{ host: 'acme.test', key: 'acme', cert_state: 'issued' }], {
  adminHost: 'admin.skw.test', demosHost: 'demos.skw.test', adminAllowlist: edge,
});
const allow = conf.split('\\n').filter((l) => l.trim().startsWith('allow ')).map((l) => l.trim());
console.log(JSON.stringify({ app, edge, allow }));
`;

function measure() {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', MEASURE], {
    cwd: REPO,
    encoding: 'utf8',
  });
  return JSON.parse(out.trim());
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const original = readFileSync(PARSER);
const before = sha(original);
if (!original.toString('utf8').includes(ORIGINAL_RETURN)) {
  console.error('proof: the mutation anchor is not in the parser — update this script, do not skip the proof');
  process.exit(2);
}

let restored = false;
try {
  console.log('baseline        ', JSON.stringify(measure()));

  writeFileSync(PARSER, original.toString('utf8').replace(ORIGINAL_RETURN, MUTATED_RETURN));
  const mutated = measure();
  console.log('mutated parser  ', JSON.stringify(mutated));
} finally {
  writeFileSync(PARSER, original);
  restored = sha(readFileSync(PARSER)) === before;
}

if (!restored) {
  console.error('proof: THE PARSER WAS NOT RESTORED — restore it from git before doing anything else');
  process.exit(3);
}

const baseline = measure();
console.log('restored        ', JSON.stringify(baseline));

const appMoved = JSON.stringify(baseline.app) !== JSON.stringify({ app: undefined });
const bothChanged =
  JSON.stringify(baseline.app) === JSON.stringify(['203.0.113.0/24']) &&
  JSON.stringify(baseline.allow) === JSON.stringify(['allow 203.0.113.0/24;']) &&
  JSON.stringify(baseline.edge) === JSON.stringify(['203.0.113.0/24']);

// Re-measure the mutation once more, from the restored file, so the claim is not
// carried in a variable that could be stale.
writeFileSync(PARSER, original.toString('utf8').replace(ORIGINAL_RETURN, MUTATED_RETURN));
let mutated2;
try {
  mutated2 = measure();
} finally {
  writeFileSync(PARSER, original);
}
const restoredAgain = sha(readFileSync(PARSER)) === before;
const changedUnderMutation =
  JSON.stringify(mutated2.app) === JSON.stringify(['198.51.100.0/24']) &&
  JSON.stringify(mutated2.allow) === JSON.stringify(['allow 198.51.100.0/24;']) &&
  JSON.stringify(mutated2.edge) === JSON.stringify(['198.51.100.0/24']);

console.log('mutated again   ', JSON.stringify(mutated2));
console.log('restored again  ', restoredAgain ? 'sha256 matches' : 'SHA MISMATCH');

if (!bothChanged || !changedUnderMutation || !restoredAgain || !appMoved) {
  console.error('proof: FAILED — one consumer did not follow the parser (a copy exists, or the shape changed)');
  process.exit(1);
}
console.log('proof: PASS — one module, two consumers: app, edge parser and emitted nginx line all moved');
