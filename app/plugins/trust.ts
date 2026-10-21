/**
 * The trust surface: D27's "no publisher CA", made real (§8.5, C-9).
 *
 * There is no certificate authority in v1, and there is no key we hold that signs a
 * third-party publisher's key. What exists is exactly two things:
 *
 *   1. **One key baked into the image** — `FIRST_PARTY_SPKI_PEM`. A package whose signature
 *      verifies against it is `first_party`, and no operator action is needed for that.
 *      Its private half is not in this tree; it lives in the release pipeline. (A gate can
 *      therefore verify the *path* with a fixture key — `firstPartyKeys` — and assert the
 *      image key by fingerprint, which is what `test/plugin-trust.test.ts` does.)
 *   2. **`<data>/trust/publishers.json`**, written only by the tenant owner importing a
 *      public key, with the fingerprint shown beside the capabilities. Nothing in this
 *      product can add to that file except `skwctl plugin trust import`.
 *
 * The signature is **detached**: `<package>.sig.json` beside the directory, not inside it.
 * That is a deliberate choice, and it is about blast radius: `packageRootHash()` is the
 * package's identity — it is what `cms_plugin_revoked`, `BUNDLE.json.plugins[].root_hash`
 * and `tools/bundle_verify.mjs` compare. A signature file *inside* the package would have
 * to be excluded from that walk in three places, and any one of them drifting would turn
 * every signed install into a root mismatch. Detached, the root hash means exactly what it
 * meant before this file existed.
 *
 * What the signature covers, and why it is the *file list* and not only the root:
 *
 *   - the publisher id and the key fingerprint (so neither can be swapped for another),
 *   - the sha256 of `plugin.json` (the manifest is the grant — see `manifest.ts`),
 *   - the path and sha256 of **every file in the package**, and
 *   - the root hash over that list.
 *
 * A root hash alone can only say "something changed". The file list is what lets the
 * refusal name the file, which is the difference between "this package is not what was
 * signed" and "index.mjs was edited after it was signed".
 */
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { AppError } from '../errors.ts';
import type { Manifest } from './manifest.ts';
import { packageRootHash } from './manifest.ts';

/** The publisher id the image's own key signs under. */
export const FIRST_PARTY_PUBLISHER = 'skunkworks';

/**
 * The key baked into the image (§8.5, D27). Ed25519, SPKI PEM.
 *
 * **This constant is a placeholder, and it fails closed.** It was generated for this slice
 * and no private half is retained in this tree — so today no package can be signed as
 * `first_party`, which is the safe direction and is named in `S4-final-report.md` §10.5
 * rather than left to be discovered. The release pipeline replaces it at image build:
 * `node tools/plugin_sign.ts --keygen --out <prefix>`, keep the `.key` in the pipeline,
 * bake the `.pub` here. Everything below it — the refusal, the fingerprint on the screen,
 * the audit row — is what the real key will use.
 */
export const FIRST_PARTY_SPKI_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA212qGylPWs2tvWKCnj0srQaklCKtu3lQvnLR6e/mjTU=
-----END PUBLIC KEY-----
`;

/** `skw-plugin-signature/1` — the only signature format this product reads. */
export const SIGNATURE_FORMAT = 'skw-plugin-signature/1';
export const TRUST_FORMAT = 'skw-trust/1';
export const PUBLISHER_ID = /^[a-z][a-z0-9-]{1,39}$/;

/** Every refused signature is this code: §8.5 lists one, and one is enough. */
const SIGNATURE = 'SKW_E_PL_SIGNATURE';

export interface SignedFile {
  path: string;
  sha256: string;
}

/** The detached `plugin.sig.json`, as the packager writes it. */
export interface SignatureFile {
  format: typeof SIGNATURE_FORMAT;
  plugin: string;
  version: string;
  publisher: string;
  /** `spki-sha256:<hex>` — the fingerprint the operator is shown. */
  key_id: string;
  algorithm: 'ed25519';
  /** The manifest's own sha256, repeated here so a manifest swap is named, not inferred. */
  manifest: string;
  root_hash: string;
  files: SignedFile[];
  /** base64 Ed25519 over `statement()`. */
  signature: string;
}

export interface PublisherKey {
  id: string;
  fingerprint: string;
  /** SPKI PEM, verbatim. */
  spki: string;
  imported_at: string;
  imported_by: string;
}

interface TrustStore {
  format: string;
  publishers: PublisherKey[];
}

export type SignatureState = 'first_party' | 'imported' | 'unsigned';

export interface VerifiedPackage {
  state: SignatureState;
  /** The publisher the screen and the row name. `unsigned` when nobody signed it. */
  publisher: string;
  fingerprint: string | null;
  /** Where the key came from — the screen says which, because it changes the decision. */
  key_source: 'image' | 'imported' | 'none';
  signature: SignatureFile | null;
  /**
   * What the *package* said its publisher was, when nothing signed that claim.
   *
   * Quarantined, not honoured: an unsigned package is `publisher='unsigned'` and this field is
   * the only place its self-declared name may appear. Before this field existed, an unsigned
   * package that wrote `"publisher": {"id": "acme-labs"}` landed in `cms_plugin_installed` and
   * in the audit chain as `publisher=acme-labs` with a null fingerprint — a package naming its
   * own trustworthiness. A name is a claim a **key** makes (§13.3.7); without a key there is no
   * claim, and this is where the claim is kept so an operator can see it was tried.
   */
  claimed_publisher: string | null;
}

function refuse(message: string, detail: Record<string, unknown> = {}): never {
  throw new AppError(SIGNATURE, message, detail);
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** `spki-sha256:<hex>` over the DER SPKI encoding — the same value OpenSSL prints. */
export function fingerprintOf(spkiPem: string): string {
  let der: Buffer;
  try {
    der = createPublicKey(spkiPem).export({ type: 'spki', format: 'der' }) as Buffer;
  } catch (err) {
    refuse(`the public key is not a PEM SPKI key: ${String(err)}`);
  }
  return `spki-sha256:${sha256Hex(der)}`;
}

/**
 * The signed bytes. Text, not JSON, deliberately: a canonical JSON encoder is a second
 * thing that can disagree with itself between the signer and the verifier, and this file
 * has to be readable by the person deciding whether to trust a package.
 */
export function statement(sig: Omit<SignatureFile, 'signature'>): Buffer {
  const lines = [
    sig.format,
    `publisher=${sig.publisher}`,
    `key_id=${sig.key_id}`,
    `plugin=${sig.plugin}`,
    `version=${sig.version}`,
    `manifest=${sig.manifest}`,
    `root=${sig.root_hash}`,
    ...[...sig.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => `file=${f.sha256} ${f.path}`),
  ];
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

// --- the trust store ---------------------------------------------------------------------

export function trustFile(trustDir: string): string {
  return join(trustDir, 'publishers.json');
}

export function readTrustStore(trustDir: string): PublisherKey[] {
  const path = trustFile(trustDir);
  if (!existsSync(path)) return [];
  let parsed: TrustStore;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as TrustStore;
  } catch (err) {
    // A trust store nobody can read is not "no keys imported": that would silently demote
    // every third-party package to unsigned, which is the failure this file exists to stop.
    refuse(`the trust store at ${path} is not readable JSON: ${String(err)}`);
  }
  if (parsed.format !== TRUST_FORMAT || !Array.isArray(parsed.publishers)) {
    refuse(`the trust store at ${path} is not ${TRUST_FORMAT}`);
  }
  return parsed.publishers.map((key) => ({
    id: String(key.id),
    fingerprint: String(key.fingerprint),
    spki: String(key.spki),
    imported_at: String(key.imported_at),
    imported_by: String(key.imported_by),
  }));
}

function writeTrustStore(trustDir: string, publishers: PublisherKey[]): void {
  mkdirSync(trustDir, { recursive: true, mode: 0o700 });
  const body: TrustStore = { format: TRUST_FORMAT, publishers };
  const path = trustFile(trustDir);
  const staging = `${path}.tmp-${process.pid}`;
  // 0600: the file is public keys, but it is also the box's entire trust decision — an
  // account that can rewrite it can install code. Only the installing account may write it.
  writeFileSync(staging, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  renameSync(staging, path);
}

export interface ImportKeyRequest {
  trustDir: string;
  publisher: string;
  /** SPKI PEM, as `openssl pkey -pubout` or `plugin_sign --keygen` writes it. */
  spkiPem: string;
  importedBy?: string;
  now?: string;
  /** Replace a different key already imported for this publisher. Off: the mismatch is a refusal. */
  replace?: boolean;
}

/**
 * Import one publisher's public key (D27's only trust act). A different key under a
 * publisher id that is already imported is **refused**, naming both fingerprints: silently
 * replacing a key is how a supply-chain swap looks like a routine upgrade.
 */
export function importPublisherKey(input: ImportKeyRequest): { key: PublisherKey; replaced: PublisherKey | null; total: number } {
  if (!PUBLISHER_ID.test(input.publisher)) {
    refuse(`publisher ${JSON.stringify(input.publisher)} is not ${PUBLISHER_ID}`);
  }
  const fingerprint = fingerprintOf(input.spkiPem);
  const keys = readTrustStore(input.trustDir);
  const existing = keys.find((k) => k.id === input.publisher);
  const key: PublisherKey = {
    id: input.publisher,
    fingerprint,
    spki: input.spkiPem.trim().endsWith('\n') ? input.spkiPem : `${input.spkiPem.trim()}\n`,
    imported_at: input.now ?? new Date().toISOString(),
    imported_by: input.importedBy ?? 'skwctl',
  };
  if (existing !== undefined && existing.fingerprint !== fingerprint && input.replace !== true) {
    refuse(
      `${input.publisher} is already imported as ${existing.fingerprint}; this key is ${fingerprint} — re-run with --replace to revoke the old key`,
      { publisher: input.publisher, imported_fingerprint: existing.fingerprint, presented_fingerprint: fingerprint },
    );
  }
  const next = existing === undefined ? [...keys, key] : keys.map((k) => (k.id === input.publisher ? key : k));
  writeTrustStore(input.trustDir, next);
  return { key, replaced: existing !== undefined && existing.fingerprint !== fingerprint ? existing : null, total: next.length };
}

// --- verification ------------------------------------------------------------------------

export interface VerifyRequest {
  /** The package directory. */
  dir: string;
  /** The detached signature path. Absent means "no signature offered" — which is legal only with `allowUnsigned`. */
  signaturePath?: string;
  trustDir?: string;
  /** Overrides the image key. A gate uses it; production never does. */
  firstPartyKeys?: string[];
  manifest: Manifest;
}

/**
 * Verify one package's signature. The order is: the signature file's own shape, the
 * cryptographic signature over its statement, then the package's bytes against the signed
 * file list — so an edit is reported as an edit and not as "the signature is bad".
 */
export function verifyPackageSignature(req: VerifyRequest): VerifiedPackage {
  if (req.signaturePath === undefined) {
    // **Unsigned is a state, not a claim.** The package may say `"publisher": {"id":"acme-labs"}`
    // in plugin.json; with no signature that sentence has no author, so it is quarantined in
    // `claimed_publisher` and the publisher the row records is the literal `unsigned`. A null
    // fingerprint beside a real-looking publisher name is exactly the row an operator would
    // misread, and this is the branch that used to produce it.
    const claimed = typeof req.manifest.publisher?.id === 'string' ? req.manifest.publisher.id : null;
    return {
      state: 'unsigned',
      publisher: 'unsigned',
      fingerprint: null,
      key_source: 'none',
      signature: null,
      claimed_publisher: claimed,
    };
  }
  if (!existsSync(req.signaturePath)) {
    // The caller asked for a specific signature and there is none. That is not "unsigned":
    // it is a missing artifact, and treating it as unsigned would be the silent path.
    refuse(`no signature file at ${req.signaturePath}`, { signature_path: req.signaturePath });
  }
  let raw: SignatureFile;
  try {
    raw = JSON.parse(readFileSync(req.signaturePath, 'utf8')) as SignatureFile;
  } catch (err) {
    refuse(`the signature file at ${req.signaturePath} is not JSON: ${String(err)}`);
  }
  if (raw.format !== SIGNATURE_FORMAT) refuse(`the signature format is ${JSON.stringify(raw.format)}, not ${SIGNATURE_FORMAT}`);
  if (raw.algorithm !== 'ed25519') refuse(`the signature algorithm is ${JSON.stringify(raw.algorithm)}; only ed25519 is read`);
  if (raw.plugin !== req.manifest.id || raw.version !== req.manifest.version) {
    refuse(
      `the signature is for ${raw.plugin}@${raw.version} but the package is ${req.manifest.id}@${req.manifest.version}`,
      { signed: `${raw.plugin}@${raw.version}`, package: `${req.manifest.id}@${req.manifest.version}` },
    );
  }
  if (!PUBLISHER_ID.test(raw.publisher)) refuse(`the signature's publisher ${JSON.stringify(raw.publisher)} is not ${PUBLISHER_ID}`);
  if (!Array.isArray(raw.files) || raw.files.length === 0) refuse('the signature carries no file list');
  if (typeof raw.signature !== 'string' || raw.signature === '') refuse('the signature carries no signature value');

  // The candidate key. First-party is decided by the publisher id, and only the image's key
  // (or a gate's explicit override) can verify it.
  const firstParty = raw.publisher === FIRST_PARTY_PUBLISHER;
  const candidates: { pem: string; source: 'image' | 'imported' }[] = firstParty
    ? (req.firstPartyKeys ?? [FIRST_PARTY_SPKI_PEM]).map((pem) => ({ pem, source: 'image' as const }))
    : (() => {
        const keys = readTrustStore(req.trustDir ?? '.');
        const found = keys.filter((k) => k.id === raw.publisher);
        if (found.length === 0) {
          refuse(`no public key is imported for publisher ${JSON.stringify(raw.publisher)} — the tenant owner must import one (skwctl plugin trust import)`, {
            publisher: raw.publisher,
            presented_fingerprint: raw.key_id,
          });
        }
        return found.map((k) => ({ pem: k.spki, source: 'imported' as const }));
      })();

  const fingerprints = candidates.map((c) => fingerprintOf(c.pem));
  if (!fingerprints.includes(raw.key_id)) {
    // The mismatch case, named from both sides. Whichever key the operator imported is the
    // one the screen shows; whichever signed the package is the one the file carries.
    refuse(
      `the package was signed by ${raw.key_id} but ${raw.publisher} is trusted as ${fingerprints.join(', ')}`,
      { publisher: raw.publisher, presented_fingerprint: raw.key_id, trusted_fingerprints: fingerprints },
    );
  }
  const match = candidates[fingerprints.indexOf(raw.key_id)] as { pem: string; source: 'image' | 'imported' };

  // The manifest's own claim, if it makes one, must agree with the signature. Two statements
  // of the publisher that disagree is not a tie to break in the package's favour.
  if (req.manifest.publisher !== undefined) {
    if (req.manifest.publisher.id !== raw.publisher || (req.manifest.publisher.key_id !== undefined && req.manifest.publisher.key_id !== raw.key_id)) {
      refuse(
        `plugin.json names publisher ${req.manifest.publisher.id} key ${req.manifest.publisher.key_id ?? '(none)'} but the signature names ${raw.publisher} key ${raw.key_id}`,
        {
          manifest_publisher: req.manifest.publisher.id,
          manifest_key_id: req.manifest.publisher.key_id ?? null,
          signed_publisher: raw.publisher,
          signed_key_id: raw.key_id,
        },
      );
    }
  }

  const { signature: encoded, ...signed } = raw;
  const bytes = statement(signed);
  let ok = false;
  try {
    ok = verifySignature(null, bytes, match.pem, Buffer.from(encoded, 'base64'));
  } catch (err) {
    refuse(`the signature could not be checked against ${raw.key_id}: ${String(err)}`);
  }
  if (!ok) refuse(`the signature does not verify against ${raw.key_id}`, { publisher: raw.publisher, fingerprint: raw.key_id });

  // The bytes. Recomputed from the directory, compared against what was signed.
  const hashed = packageRootHash(req.dir);
  const now = new Map(hashed.files.map((f) => [f.path, f.sha256]));
  const signedFiles = new Map(raw.files.map((f) => [f.path, f.sha256]));
  for (const file of [...raw.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const actual = now.get(file.path);
    if (actual === undefined) {
      refuse(`the package was edited after it was signed: ${file.path} is in the signature and not in the package`, {
        file: file.path,
        signed_sha256: file.sha256,
        actual_sha256: null,
      });
    }
    if (actual !== file.sha256) {
      refuse(`the package was edited after it was signed: ${file.path}`, {
        file: file.path,
        signed_sha256: file.sha256,
        actual_sha256: actual,
      });
    }
  }
  for (const file of hashed.files) {
    if (!signedFiles.has(file.path)) {
      refuse(`the package was edited after it was signed: ${file.path} was added`, {
        file: file.path,
        signed_sha256: null,
        actual_sha256: file.sha256,
      });
    }
  }
  if (raw.root_hash !== hashed.root) {
    // Unreachable while every file matched; kept because the root is what the row, the
    // revocation table and the exporter compare, and "every file matched but the root did
    // not" must never be a silent pass.
    refuse(`the package root is ${hashed.root} but the signature covers ${raw.root_hash}`, {
      signed_root_hash: raw.root_hash,
      package_root_hash: hashed.root,
    });
  }

  return {
    state: firstParty ? 'first_party' : 'imported',
    publisher: raw.publisher,
    fingerprint: raw.key_id,
    key_source: match.source,
    signature: raw,
    // A signed package's publisher is the key's, and there is nothing quarantined: the manifest's
    // claim was already required to agree with the signature above.
    claimed_publisher: null,
  };
}

// --- the §8.5 install screen -------------------------------------------------------------

/** Every one of §8.3's 14 operations, in words a non-developer can decide on. */
export const CAPABILITY_TEXT: Readonly<Record<string, string>> = {
  'store.insert': 'write a row into one of its own tables',
  'store.update': 'change rows in its own tables',
  'store.delete': 'delete rows from its own tables',
  'store.query': 'read rows from its own tables',
  'store.count': 'count rows in its own tables',
  'settings.get': 'read its own settings',
  'settings.has': 'ask whether one of its settings exists',
  'settings.set': 'write its own settings',
  'assets.resolve': 'look up a media library item by key',
  'mail.send': 'send email through this install’s mailer',
  'util.now': 'read the clock',
  'util.random': 'generate random bytes',
  'util.hash': 'hash a value',
  'log.write': 'write a line to the site log',
};

/**
 * E-33 item 6 / `SDS.md` §13.3.7's drop-in sentence, **verbatim**, printed under every
 * capability list on the install screen.
 *
 * The screen shows the `capabilities` array in plain words, and a non-developer reads a list of
 * permissions as a boundary. After D36 there is no layer doing the containing: a plugin runs in
 * the site's own process and can open `data/control.db` with its own `better-sqlite3` handle or
 * send mail through a socket it opens itself (§13.3.7, §13.4 item 5). Capabilities are
 * **disclosure**, and this is the sentence that says so — `test/plugin-install.test.ts` P1
 * asserts it appears character for character, parsed out of `docs/sds/02-errata.md` so the
 * screen and the errata cannot drift apart.
 */
export const CAPABILITIES_ARE_DISCLOSURE =
  "Capabilities describe what this plugin asks the CMS for. They do not limit what its code can do: a plugin runs inside the site's process, with the site's own access to its files and databases.";

export interface InstallScreen {
  plugin: string;
  version: string;
  description: string | null;
  publisher: string;
  publisher_key_fingerprint: string | null;
  key_source: 'image' | 'imported' | 'none';
  first_party: boolean;
  signature_state: SignatureState;
  signature: { algorithm: string; files: number; root_hash: string } | null;
  capabilities: { op: string; plain: string }[];
  tables: { name: string; export: string; columns: number }[];
  settings: { key: string; type: string; secret: boolean }[];
  endpoints: { name: string; method: string }[];
  test_report: { ran_at: string; sha256: string; runner_image_digest: string };
  root_hash: string;
  /** Loud, and repeated in the audit row. */
  unsigned: boolean;
  /**
   * What an unsigned package called itself, shown *as a rejected claim* beside
   * `publisher: "unsigned"`. Never merged into the publisher field: the screen a human decides
   * on must not contain a publisher name that no key vouched for.
   */
  claimed_publisher: string | null;
}

export interface ScreenRequest {
  manifest: Manifest;
  verified: VerifiedPackage;
  root: string;
  report: { sha256: string; ran_at: string; runner_image_digest: string };
}

export function installScreen(req: ScreenRequest): InstallScreen {
  const { manifest, verified } = req;
  return {
    plugin: manifest.id,
    version: manifest.version,
    description: manifest.description ?? null,
    publisher: verified.publisher,
    publisher_key_fingerprint: verified.fingerprint,
    key_source: verified.key_source,
    first_party: verified.state === 'first_party',
    signature_state: verified.state,
    signature:
      verified.signature === null
        ? null
        : {
            algorithm: verified.signature.algorithm,
            files: verified.signature.files.length,
            root_hash: verified.signature.root_hash,
          },
    capabilities: manifest.capabilities.map((op) => ({ op, plain: CAPABILITY_TEXT[op] ?? op })),
    tables: manifest.tables.map((t) => ({ name: t.name, export: t.export, columns: (t.columns ?? []).length })),
    settings: manifest.settings.map((s) => ({ key: s.key, type: s.type, secret: s.type === 'secret' })),
    endpoints: (manifest.endpoints ?? []).map((e) => ({ name: e.name, method: e.method })),
    test_report: req.report,
    root_hash: req.root,
    unsigned: verified.state === 'unsigned',
    claimed_publisher: verified.claimed_publisher,
  };
}

/** `<data>/trust` from a tenant's `site.db` — the same shape `uninstall` uses for its archive. */
export function trustDirFor(siteDb: string): string {
  return join(dirname(siteDb), '..', '..', 'trust');
}
