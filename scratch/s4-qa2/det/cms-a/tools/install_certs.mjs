#!/usr/bin/env node
/**
 * The install-time TLS pair (§12.5, S4e).
 *
 * `install.sh` calls this **before** `docker compose up` so that the first boot of a cold
 * bundle has a certificate for every host nginx names. It is the missing half of the S4
 * defect: the bundle said `issued`, the exporter shipped no key (it cannot), and nginx
 * refused to load a file that had never existed. Two rules make the state honest:
 *
 *   - the file is minted **only when absent**. A re-install must never overwrite a
 *     certificate the ACME service has already issued — that would downgrade a working
 *     HTTPS site to a self-signed one on `./install.sh` being run twice.
 *   - `cert_state` is **not** written here. It stays `none` in the seed, the install report
 *     prints `certificate: pending (self-signed)`, and only the `acme` service writes
 *     `issued` — after it has written the bytes on this host.
 *
 * One pair per tenant, named for the tenant's first host (the file `nginx_gen` points the
 * block at), with every host of that tenant in the SAN set. Plus `default.crt|key` for the
 * admin and demos vhosts, which are not tenant domains and never get a per-host issuance.
 *
 * `openssl` is the one host dependency: generating an X509 certificate without it would mean
 * re-implementing a CA in this file, and every supported install host has it.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function usage(message) {
  process.stderr.write(`install_certs: ${message}\nusage: install_certs.mjs --data DIR --certs DIR [--default-host HOST]...\n`);
  process.exit(2);
}

const argv = process.argv.slice(2);
let dataDir = '';
let certsDir = '';
const defaultHosts = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--data') dataDir = argv[++i] ?? '';
  else if (argv[i] === '--certs') certsDir = argv[++i] ?? '';
  else if (argv[i] === '--default-host') defaultHosts.push(argv[++i] ?? '');
  else usage(`unknown argument ${argv[i]}`);
}
if (dataDir === '') usage('--data is required');
if (certsDir === '') usage('--certs is required');

if (!existsSync(join(dataDir, 'control.db'))) usage(`no control.db at ${dataDir}/control.db — run the schema and seed steps first`);

let openssl;
try {
  openssl = process.env.OPENSSL ?? 'openssl';
  execFileSync(openssl, ['version'], { stdio: 'ignore' });
} catch {
  process.stderr.write('install_certs: REFUSAL: openssl is not installed; nginx cannot start without a certificate for each host\n');
  process.exit(17);
}

mkdirSync(certsDir, { recursive: true, mode: 0o700 });

/** `openssl req -x509` into `path.crt|key`, with a SAN set for every name the block serves. */
function mint(cn, sans, crt, key) {
  if (existsSync(crt) && existsSync(key) && statSync(crt).size > 0 && statSync(key).size > 0) return false;
  const alt = [...new Set([cn, ...sans])].map((name) => `DNS:${name}`).join(',');
  execFileSync(
    openssl,
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-sha256',
      '-nodes',
      '-days',
      '3650',
      '-subj',
      `/CN=${cn}`,
      '-addext',
      `subjectAltName=${alt}`,
      '-keyout',
      key,
      '-out',
      crt,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  chmodSync(key, 0o600);
  chmodSync(crt, 0o644);
  return true;
}

const db = new DatabaseSync(join(dataDir, 'control.db'), { readOnly: true });
let tenants;
try {
  tenants = db
    .prepare(
      `SELECT t.key AS key, d.host AS host
         FROM domain d JOIN tenant t ON t.id = d.tenant_id
        WHERE d.kind <> 'demo-path'
        ORDER BY t.key, d.host`,
    )
    .all();
} finally {
  db.close();
}

const byTenant = new Map();
for (const row of tenants) {
  const list = byTenant.get(row.key) ?? [];
  list.push(row.host);
  byTenant.set(row.key, list);
}

let minted = 0;
let kept = 0;
for (const [key, hosts] of byTenant) {
  if (hosts.length === 0) continue;
  // `hosts` is ordered by host, which is the order `nginx_gen` uses to pick the file name.
  const primary = hosts[0];
  const crt = join(certsDir, `${primary}.crt`);
  const keyFile = join(certsDir, `${primary}.key`);
  const created = mint(primary, hosts, crt, keyFile);
  if (created) {
    minted += 1;
    process.stdout.write(`certificate: pending (self-signed) ${primary} for ${hosts.join(',')}\n`);
  } else {
    kept += 1;
    process.stdout.write(`certificate: kept ${primary}.crt (an issued pair is never overwritten)\n`);
  }
}

// The admin and demos vhosts are not tenant domains: one pair, named by the generator.
const fallbackHosts = defaultHosts.filter((h) => h !== '');
const fallbackCn = fallbackHosts[0] ?? 'skunkworks-default';
if (mint(fallbackCn, fallbackHosts, join(certsDir, 'default.crt'), join(certsDir, 'default.key'))) {
  minted += 1;
  process.stdout.write(`certificate: pending (self-signed) default for ${fallbackHosts.join(',') || fallbackCn}\n`);
} else {
  kept += 1;
}

process.stdout.write(`certificates: ${minted} minted, ${kept} kept, in ${certsDir}\n`);
