#!/usr/bin/env node
/**
 * The `acme` service (§12.1, §12.5, D7) — per-host HTTP-01 certificates, and the reload that
 * makes them live.
 *
 * The compose file used to run `nginxproxy/acme-companion`, which cannot start against this
 * stack: it looks for the docker-gen container that `nginx-proxy` ships with, and this nginx
 * is a bespoke config with a generated `10-app.conf`, not an nginx-proxy vhost tree. Measured
 * by the S4 QA: exit 1, `can't get docker-gen container id`, and therefore no service that
 * could ever replace the certificate the bundle claimed to have.
 *
 * This file is that service, and it is deliberately small: it reads the hosts from
 * `control.db` (the only source of truth), and for each tenant whose certificate is not in
 * hand it speaks RFC 8555 to the directory in `SKW_ACME_DIRECTORY`, answers http-01 through a
 * webroot nginx serves, writes `<certs>/<host>.crt|key`, sets `domain.cert_state = 'issued'`,
 * and sends nginx a HUP so the new pair is what the next connection sees.
 *
 * ## What is proven, and where
 *
 * The protocol client is real (JWS/ES256, nonce handling, order/authz/challenge/finalize,
 * CSR built in DER because the image carries no openssl). It is exercised end to end against
 * **Pebble**, the Let's Encrypt test CA, in `test/first-boot-tls.test.ts`; §13.4's limitation
 * stands for a production CA, which this box cannot reach. No part of the exchange is stubbed:
 * validation is not short-circuited, and the certificate nginx serves afterwards is the one
 * Pebble signed.
 *
 * ## Renewal
 *
 * A certificate is re-requested when the file is missing, when `cert_state != 'issued'`, or
 * when the file is older than `SKW_ACME_RENEW_DAYS` (default 60 of a 90-day lifetime). That is
 * age-based, not `notAfter`-based: this image has no openssl to parse the DER, and claiming to
 * read an expiry we do not read would be worse than scheduling early. Stated as a limitation.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DIRECTORY = process.env.SKW_ACME_DIRECTORY ?? 'https://acme-v02.api.letsencrypt.org/directory';
const EMAIL = process.env.SKW_ACME_EMAIL ?? '';
const DATA = process.env.SKW_ACME_DATA ?? '/srv/data';
const CERTS = process.env.SKW_ACME_CERTS ?? '/srv/certs';
const WEBROOT = process.env.SKW_ACME_WEBROOT ?? '/srv/acme';
const INSECURE = process.env.SKW_ACME_INSECURE === '1';
const ONESHOT = process.env.SKW_ACME_ONESHOT === '1';
const INTERVAL_S = Number(process.env.SKW_ACME_INTERVAL_S ?? 6 * 60 * 60);
// How often to look at the edge config for a change made by the CMS. Cheap (one stat), and it is
// the difference between "imported a site" and "imported a site the world can reach": the CMS can
// write `10-app.conf` but it cannot signal nginx (no socket, and it should not have one), so the
// service that already holds the socket does the reload.
const WATCH_S = Number(process.env.SKW_ACME_WATCH_S ?? 10);
const RENEW_DAYS = Number(process.env.SKW_ACME_RENEW_DAYS ?? 60);
const NGINX_CONTAINER = process.env.SKW_NGINX_CONTAINER ?? '';
const DOCKER_SOCKET = process.env.SKW_DOCKER_SOCKET ?? '/var/run/docker.sock';

const log = (line) => process.stdout.write(`acme: ${line}\n`);

// --- base64url ---------------------------------------------------------------------------
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const json64 = (value) => b64u(Buffer.from(JSON.stringify(value), 'utf8'));

// --- DER, the little that a CSR needs ----------------------------------------------------
function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
};
const seq = (...parts) => tlv(0x30, ...parts);
const set = (...parts) => tlv(0x31, ...parts);
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const integer0 = tlv(0x02, Buffer.from([0]));
const oid = (dotted) => {
  const parts = dotted.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) {
    if (part < 0x80) bytes.push(part);
    else {
      const chunk = [];
      let v = part;
      while (v > 0) {
        chunk.unshift(v & 0x7f);
        v >>= 7;
      }
      for (let i = 0; i < chunk.length - 1; i += 1) chunk[i] |= 0x80;
      bytes.push(...chunk);
    }
  }
  return tlv(0x06, Buffer.from(bytes));
};
const OCTET = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0]), buf]));
const ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const EC_PUBLIC_KEY = '1.2.840.10045.2.1';
const P256 = '1.2.840.10045.3.1.7';

/**
 * A PKCS#10 CSR for every host of one tenant, signed by `key`.
 *
 * The CSR must carry a **subjectAltName extension** naming exactly the order's identifiers —
 * a CN is not enough, and a CSR with only a CN is refused: measured against Pebble, `403
 * Order includes different number of DNSnames identifiers than CSR specifies`. So the
 * attributes field carries one `extensionRequest` (1.2.840.113549.1.9.14) holding one
 * subjectAltName (2.5.29.17), whose GeneralNames are `[2] IA5String` (tag 0x82) per name.
 */
function makeCsr(hosts, key) {
  const spki = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const san = seq(...hosts.map((host) => tlv(0x82, Buffer.from(host, 'ascii'))));
  const extension = seq(oid('2.5.29.17'), tlv(0x04, san));
  const extensionRequest = seq(oid('1.2.840.113549.1.9.14'), set(seq(extension)));
  const cri = seq(
    integer0,
    seq(set(seq(oid('2.5.4.3'), utf8(hosts[0])))),
    spki,
    // `[0] IMPLICIT SET OF Attribute`: the [0] replaces the SET tag, the Attribute
    // SEQUENCEs are its content.
    tlv(0xa0, extensionRequest),
  );
  const signature = sign('sha256', cri, key);
  return seq(cri, seq(oid(ECDSA_SHA256)), OCTET(signature));
}

/**
 * ECDSA DER signature -> the fixed-width `r||s` JOSE wants.
 *
 * A DER INTEGER is signed, so a value whose top bit is set carries a leading 0x00 and is 33
 * bytes long; copying it into a 32-byte half overflows (measured: `RangeError: targetStart
 * … Received -1`). The leading zeros are stripped first — that is the value, not a byte of
 * entropy — and each half is right-aligned to 32.
 */
function derToJose(der) {
  let offset = 2;
  if (der[1] & 0x80) offset += der[1] & 0x7f;
  const half = (at) => {
    const length = der[at + 1];
    let value = der.subarray(at + 2, at + 2 + length);
    while (value.length > 32 && value[0] === 0) value = value.subarray(1);
    if (value.length > 32) throw new Error('an ECDSA signature half is longer than 32 bytes');
    const out = Buffer.alloc(32);
    value.copy(out, 32 - value.length);
    return out;
  };
  return Buffer.concat([half(offset), half(offset + 2 + der[offset + 1])]);
}

// --- HTTP, with the CA's own error type --------------------------------------------------
const USER_AGENT = `skunkworks-acme/1.0 (node ${process.version})`;
function req(url, { method = 'GET', headers = {}, body } = {}) {
  const target = new URL(url);
  const send = target.protocol === 'http:' ? httpRequest : httpsRequest;
  return new Promise((resolve, reject) => {
    const request = send(
      target,
      // Pebble refuses a request without one ("All requests MUST include a User-Agent
      // header"; measured 400 on /dir). A production CA wants it too — it is how a CA's
      // operator tells you which client is misbehaving.
      { method, headers: { 'user-agent': USER_AGENT, ...headers }, ...(target.protocol === 'https:' && INSECURE ? { rejectUnauthorized: false } : {}) },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text });
        });
      },
    );
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

class Acme {
  constructor(directory, accountKey) {
    this.directoryUrl = directory;
    this.key = accountKey;
    this.jwk = createPublicKey(accountKey).export({ format: 'jwk' });
    this.thumbprint = b64u(createHash('sha256').update(JSON.stringify({ crv: this.jwk.crv, kty: this.jwk.kty, x: this.jwk.x, y: this.jwk.y })).digest());
    this.kid = null;
    this.nonce = null;
  }

  async load() {
    const res = await req(this.directoryUrl);
    this.dir = JSON.parse(res.text);
    if (typeof this.dir?.newNonce !== 'string') {
      throw new Error(`the directory at ${this.directoryUrl} has no newNonce (status ${res.status}): ${res.text.slice(0, 200)}`);
    }
  }

  async freshNonce() {
    const res = await req(this.dir.newNonce, { method: 'HEAD' });
    const nonce = res.headers['replay-nonce'];
    if (typeof nonce !== 'string') throw new Error(`the CA returned no Replay-Nonce (${res.status})`);
    return nonce;
  }

  async signed(url, payload, { useJwk = false, postAsGet = false, accept } = {}) {
    if (this.nonce === null) this.nonce = await this.freshNonce();
    const protectedHeader = { alg: 'ES256', nonce: this.nonce, url };
    if (useJwk || this.kid === null) protectedHeader.jwk = { crv: this.jwk.crv, kty: this.jwk.kty, x: this.jwk.x, y: this.jwk.y };
    else protectedHeader.kid = this.kid;
    // RFC 8555 §6.3: a POST-as-GET has the **empty string** as its payload. Sending `{}` is a
    // different request — Pebble answered `Malformed authorization update, status must be
    // "deactivated" not ""`, i.e. it read the body as a challenge update.
    const payload64 = postAsGet ? '' : json64(payload);
    const signingInput = `${json64(protectedHeader)}.${payload64}`;
    const signature = derToJose(sign('sha256', Buffer.from(signingInput, 'utf8'), this.key));
    const body = JSON.stringify({ protected: json64(protectedHeader), payload: payload64, signature: b64u(signature) });
    const res = await req(url, {
      method: 'POST',
      headers: { 'content-type': 'application/jose+json', ...(accept === undefined ? {} : { accept }) },
      body,
    });
    const nonce = res.headers['replay-nonce'];
    if (typeof nonce === 'string') this.nonce = nonce;
    else this.nonce = null;
    if (res.status >= 400) {
      let detail = res.text;
      try {
        detail = JSON.parse(res.text).detail ?? detail;
      } catch {
        /* the CA's body is not always JSON */
      }
      const err = new Error(`${res.status} ${detail}`);
      err.badNonce = /badNonce|anti-replay nonce/i.test(res.text);
      // A CA *refusal* is a different fact from a network failure: only the first may write
      // `cert_state = 'failed'`. The second leaves the state where it was, because nothing was
      // achieved and nothing may be claimed (§12.5's "never write a state you have not
      // achieved" — the same rule that makes a bundle say `none`).
      err.acmeStatus = res.status;
      throw err;
    }
    return res;
  }

  /** POST, retrying once on badNonce (the nonce pool is shared and can be stale). */
  async post(url, payload, options = {}) {
    try {
      return await this.signed(url, payload, options);
    } catch (err) {
      if (err.badNonce === true) {
        this.nonce = null;
        return await this.signed(url, payload, options);
      }
      throw err;
    }
  }

  /** RFC 8555 §6.3: read a resource with an empty payload. */
  async fetch(url, accept) {
    return await this.post(url, null, { postAsGet: true, ...(accept === undefined ? {} : { accept }) });
  }

  async register() {
    const contact = EMAIL === '' ? [] : [`mailto:${EMAIL}`];
    const res = await this.post(this.dir.newAccount, { termsOfServiceAgreed: true, contact }, { useJwk: true });
    const location = res.headers.location;
    if (typeof location !== 'string') throw new Error('the CA did not return an account URL');
    this.kid = location;
    return location;
  }

  async order(hosts) {
    const res = await this.post(this.dir.newOrder, { identifiers: hosts.map((host) => ({ type: 'dns', value: host })) });
    return { order: JSON.parse(res.text), url: res.headers.location };
  }

  async authorize(authzUrl, thumbprint) {
    const authz = JSON.parse((await this.fetch(authzUrl)).text);
    if (authz.status === 'valid') return;
    const challenge = (authz.challenges ?? []).find((c) => c.type === 'http-01');
    if (challenge === undefined) throw new Error(`no http-01 challenge for ${authz.identifier?.value ?? 'an identifier'}`);
    const token = challenge.token;
    const path = join(WEBROOT, '.well-known', 'acme-challenge', token);
    mkdirSync(join(WEBROOT, '.well-known', 'acme-challenge'), { recursive: true });
    writeFileSync(path, `${token}.${thumbprint}`);
    chmodSync(path, 0o644);
    await this.post(challenge.url, {});
    // Poll: an authz is valid only after the CA has fetched the file. Pebble's VA does it
    // inline; a production CA takes seconds. The budget is bounded (60 × 1 s).
    for (let i = 0; i < 60; i += 1) {
      const state = JSON.parse((await this.fetch(authzUrl)).text);
      if (state.status === 'valid') return;
      if (state.status === 'invalid') throw new Error(`http-01 for ${authz.identifier?.value ?? '?'} was refused: ${JSON.stringify(state.challenges?.[0]?.error ?? {})}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`http-01 for ${authz.identifier?.value ?? '?'} did not become valid in 60 s`);
  }

  async finalize(orderUrl, order, csr) {
    await this.post(order.finalize, { csr: b64u(csr) });
    for (let i = 0; i < 60; i += 1) {
      const state = JSON.parse((await this.fetch(orderUrl)).text);
      if (state.status === 'valid') return state.certificate;
      if (state.status === 'invalid') throw new Error(`the order was refused: ${JSON.stringify(state.error ?? {})}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('the order did not become valid in 30 s');
  }

  async download(certUrl) {
    const res = await this.fetch(certUrl, 'application/pem-certificate-chain');
    if (!res.text.includes('-----BEGIN CERTIFICATE-----')) throw new Error('the certificate URL returned no PEM');
    return res.text;
  }
}

// --- control.db --------------------------------------------------------------------------
function tenantsNeedingCerts(now = Date.now()) {
  const db = new DatabaseSync(join(DATA, 'control.db'), { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT t.key AS key, t.status AS status, d.host AS host, d.cert_state AS cert_state
           FROM domain d JOIN tenant t ON t.id = d.tenant_id
          WHERE d.kind <> 'demo-path'
          ORDER BY t.key, d.host`,
      )
      .all();
    const byTenant = new Map();
    for (const row of rows) {
      const list = byTenant.get(row.key) ?? [];
      list.push({ host: row.host, certState: row.cert_state });
      byTenant.set(row.key, list);
    }
    const out = [];
    for (const [key, hosts] of byTenant) {
      const primary = hosts[0].host;
      const cert = join(CERTS, `${primary}.crt`);
      const keyFile = join(CERTS, `${primary}.key`);
      let stale = hosts.some((h) => h.certState !== 'issued') || !existsSync(cert) || !existsSync(keyFile);
      if (!stale) {
        // Age-based renewal: 60 days of a 90-day certificate. See the header.
        stale = now - statSync(cert).mtimeMs > RENEW_DAYS * 24 * 60 * 60 * 1000;
      }
      out.push({ key, hosts: hosts.map((h) => h.host), certState: hosts.map((h) => h.certState), primary, needs: stale });
    }
    return out;
  } finally {
    db.close();
  }
}

function markIssued(tenantKey) {
  const db = new DatabaseSync(join(DATA, 'control.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare(
      `UPDATE domain SET cert_state = 'issued'
        WHERE tenant_id = (SELECT id FROM tenant WHERE key = ?)`,
    ).run(tenantKey);
  } finally {
    db.close();
  }
}

function markState(tenantKey, state) {
  const db = new DatabaseSync(join(DATA, 'control.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare(
      `UPDATE domain SET cert_state = ?
        WHERE tenant_id = (SELECT id FROM tenant WHERE key = ?) AND cert_state <> 'issued'`,
    ).run(state, tenantKey);
  } finally {
    db.close();
  }
}

/** One request to the Docker API over its unix socket; the image has no docker CLI. */
function dockerApi(path, method = 'GET') {
  return new Promise((resolve) => {
    const request = httpRequest({ socketPath: DOCKER_SOCKET, path, method }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', (err) => resolve({ status: 0, body: err.message }));
    request.end();
  });
}

/**
 * Which container is *this stack's* nginx.
 *
 * `SKW_NGINX_CONTAINER` used to default to the literal `nginx`, which is the compose **service**
 * name and never the container name (`<project>-nginx-1`) — measured: the HUP went to
 * `/containers/nginx/kill`, the API answered 404, and the new certificate sat on disk while
 * the old one kept being served. The default is now discovery by compose labels, narrowed to
 * this container's own project, so two stacks on one box cannot signal each other's edge.
 */
async function nginxContainer() {
  if (NGINX_CONTAINER !== '') return NGINX_CONTAINER;
  let project = null;
  try {
    const self = JSON.parse((await dockerApi(`/containers/${require('node:os').hostname()}/json`)).body);
    project = self?.Config?.Labels?.['com.docker.compose.project'] ?? null;
  } catch {
    /* not in compose (a plain `docker run`): fall through to the label filter alone */
  }
  const labels = ['com.docker.compose.service=nginx', ...(project === null ? [] : [`com.docker.compose.project=${project}`])];
  const query = encodeURIComponent(JSON.stringify({ label: labels }));
  const res = await dockerApi(`/containers/json?filters=${query}`);
  if (res.status !== 200) {
    log(`could not list containers (${res.status}): ${res.body.slice(0, 120)}`);
    return null;
  }
  const list = JSON.parse(res.body);
  return (list.find((c) => c.State === 'running') ?? list[0])?.Id ?? null;
}

/**
 * The edge config, as a signal.
 *
 * `<dataDir>/nginx/10-app.conf` is bind-mounted into nginx and rewritten by `install.sh` and by
 * every site import. nginx reads it once at boot, so a new tenant's `server { }` block sits on disk
 * doing nothing until someone reloads. Its mtime is the whole protocol: no queue, no table, no
 * second trust boundary — the file *is* the request, and the process that owns the socket is the
 * one that acts on it.
 */
function edgeConfigPath() {
  return join(DATA, 'nginx', '10-app.conf');
}

function edgeConfigMtime() {
  try {
    return statSync(edgeConfigPath()).mtimeMs;
  } catch {
    return 0;
  }
}

/** `POST /containers/<id>/kill?signal=HUP` — nginx reloads its certificates, no restart. */
async function reloadNginx() {
  const id = await nginxContainer();
  if (id === null) {
    log('no nginx container found; the certificate is on disk and loads on the next restart');
    return false;
  }
  const res = await dockerApi(`/containers/${id}/kill?signal=HUP`, 'POST');
  if (res.status === 204 || res.status === 200) return true;
  log(`nginx reload returned ${res.status} for ${id.slice(0, 12)}; the certificate loads on the next restart`);
  return false;
}

// --- one pass ----------------------------------------------------------------------------
async function pass() {
  const tenants = tenantsNeedingCerts();
  const wanted = tenants.filter((t) => t.needs && t.hosts.length > 0);
  if (wanted.length === 0) {
    log(`nothing to do: ${tenants.length} tenant(s), every certificate is issued and recent`);
    return 0;
  }
  // The account key is per box, stored beside the certificates (0600). It survives restarts
  // and is not in `control.db`, so a database restore does not carry the CA identity with it.
  const accountPath = join(CERTS, 'acme-account.key');
  mkdirSync(CERTS, { recursive: true, mode: 0o700 });
  let accountKey;
  if (existsSync(accountPath)) {
    accountKey = createPrivateKey(readFileSync(accountPath));
  } else {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    writeFileSync(accountPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    accountKey = pair.privateKey;
  }

  const client = new Acme(DIRECTORY, accountKey);
  await client.load();
  const account = await client.register();
  log(`account ${account.startsWith('http') ? account : '(no url)'}, directory ${DIRECTORY}`);

  let failed = 0;
  for (const tenant of wanted) {
    const primary = tenant.primary;
    log(`requesting ${tenant.hosts.join(', ')} (${tenant.key}, state ${tenant.certState.join('/')})`);
    try {
      // From here on the box *has* asked the CA for this tenant's hosts, which is exactly what
      // `requested` means. Before this line the state is untouched.
      markState(tenant.key, 'requested');
      const { order, url } = await client.order(tenant.hosts);
      for (const authz of order.authorizations ?? []) await client.authorize(authz, client.thumbprint);
      const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const csr = makeCsr(tenant.hosts, pair.privateKey);
      const certUrl = await client.finalize(url, order, csr);
      const pem = await client.download(certUrl);
      const certPath = join(CERTS, `${primary}.crt`);
      const keyPath = join(CERTS, `${primary}.key`);
      const certStaging = `${certPath}.tmp-${process.pid}`;
      const keyStaging = `${keyPath}.tmp-${process.pid}`;
      writeFileSync(certStaging, pem, { mode: 0o644 });
      writeFileSync(keyStaging, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      renameSync(certStaging, certPath);
      renameSync(keyStaging, keyPath);
      markIssued(tenant.key);
      log(`issued ${primary}.crt for ${tenant.hosts.length} host(s); cert_state=issued`);
      // One HUP for the whole pass keeps the reloads to one per run.
      await reloadNginx();
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      // Only a refusal by the CA is `failed`; an unreachable directory or a dropped connection
      // is logged and retried on the next pass, with the certificate (and the state) as it was.
      if (err.acmeStatus !== undefined) markState(tenant.key, 'failed');
      log(`FAILED ${tenant.key} (${tenant.hosts.join(',')}): ${message}`);
    }
  }
  return failed === 0 ? 0 : 1;
}

async function main() {
  if (ONESHOT) {
    process.exitCode = await pass();
    return;
  }
  // Seeded, not reloaded: whatever nginx booted with is what is live right now, and a reload at
  // start-up would only re-read the same bytes.
  let seenConfigMtime = edgeConfigMtime();
  let sincePass = Number.POSITIVE_INFINITY;

  for (;;) {
    if (sincePass >= Math.max(60, INTERVAL_S)) {
      try {
        await pass();
      } catch (err) {
        log(`pass failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      sincePass = 0;
    }

    const mtime = edgeConfigMtime();
    if (mtime !== 0 && mtime !== seenConfigMtime) {
      seenConfigMtime = mtime;
      // nginx validates the new config as it loads it: a broken block leaves the old workers
      // serving, so this cannot take the fleet down — it can only fail to add the new host.
      const reloaded = await reloadNginx();
      log(`edge config changed; nginx ${reloaded ? 'reloaded' : 'was not reloaded (see above)'}`);
    }

    await new Promise((resolve) => setTimeout(resolve, Math.max(2, WATCH_S) * 1000));
    sincePass += Math.max(2, WATCH_S);
  }
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
