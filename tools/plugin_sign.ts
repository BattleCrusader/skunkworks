/**
 * The packager's half of D27: generate a publisher keypair, and sign a package.
 *
 *   node tools/plugin_sign.ts --keygen --out <prefix>
 *       writes <prefix>.key (PKCS#8 private, 0600) and <prefix>.pub (SPKI PEM), and prints
 *       the fingerprint an operator will be shown beside the capabilities.
 *
 *   node tools/plugin_sign.ts --dir <package> --key <private.pem> --publisher <id> \
 *                             [--out <package>.sig.json]
 *       writes the detached `skw-plugin-signature/1` file that `skwctl plugin install
 *       --signature` verifies.
 *
 * It is a `.ts` file, not `.mjs`, because it must build the signed statement with the
 * *same* function the verifier uses (`app/plugins/trust.ts`). Two implementations of a
 * canonical encoding is one implementation and one bug; the gate that proves a signed
 * install and the gate that proves an edited file is refused would both stay green while
 * the two drifted in some path neither case covers.
 *
 * Nothing here is on the install path: the signature is checked by `install.ts`, and this
 * tool only writes a file. It reads `--dir`/`--key`/`--out` from argv and resolves no path
 * from `import.meta.url`, so E-28's rule has no claim on it.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { readManifest, packageRootHash } from '../app/plugins/manifest.ts';
import { FIRST_PARTY_PUBLISHER, PUBLISHER_ID, SIGNATURE_FORMAT, fingerprintOf, statement, type SignatureFile } from '../app/plugins/trust.ts';

function fail(message: string): never {
  process.stderr.write(`plugin_sign: ${message}\n`);
  process.exit(1);
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) fail(`--${name} needs a value`);
  return value;
}

function keygen(): number {
  const out = flag('out') ?? fail('--keygen needs --out <prefix>');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  mkdirSync(dirname(resolve(out)), { recursive: true });
  // The private half is the publisher's identity: 0600, and never inside a package.
  writeFileSync(`${out}.key`, priv, { mode: 0o600 });
  writeFileSync(`${out}.pub`, pub, { mode: 0o644 });
  process.stdout.write(`plugin_sign: wrote ${out}.key (0600) and ${out}.pub\n`);
  process.stdout.write(`plugin_sign: fingerprint ${fingerprintOf(pub)}\n`);
  return 0;
}

function signPackage(): number {
  const dir = flag('dir') ?? fail('signing needs --dir <package>');
  const keyPath = flag('key') ?? fail('signing needs --key <private.pem>');
  const publisher = flag('publisher') ?? fail(`signing needs --publisher <id> (${FIRST_PARTY_PUBLISHER} for a first-party package)`);
  if (!PUBLISHER_ID.test(publisher)) fail(`publisher ${JSON.stringify(publisher)} is not ${PUBLISHER_ID}`);
  if (!existsSync(join(dir, 'plugin.json'))) fail(`${dir} has no plugin.json`);

  const manifest = readManifest(dir);
  const { root, files } = packageRootHash(dir);
  const privateKey = createPrivateKey(readFileSync(keyPath));
  const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  const keyId = fingerprintOf(publicPem);
  const manifestBytes = readFileSync(join(dir, 'plugin.json'));

  const signed: Omit<SignatureFile, 'signature'> = {
    format: SIGNATURE_FORMAT,
    plugin: manifest.id,
    version: manifest.version,
    publisher,
    key_id: keyId,
    algorithm: 'ed25519',
    manifest: createHash('sha256').update(manifestBytes).digest('hex'),
    root_hash: root,
    files: files.map((f) => ({ path: f.path, sha256: f.sha256 })),
  };
  const signature = signBytes(null, statement(signed), privateKey).toString('base64');
  const out = flag('out') ?? join(dir, '..', `${manifest.id}-${manifest.version}.sig.json`);
  const body: SignatureFile = { ...signed, signature };
  writeFileSync(out, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write(`plugin_sign: signed ${manifest.id}@${manifest.version} as ${publisher} key ${keyId}\n`);
  process.stdout.write(`plugin_sign: ${files.length} file(s), root ${root}\n`);
  process.stdout.write(`plugin_sign: signature ${out}\n`);
  return 0;
}

if (process.argv.includes('--keygen')) process.exit(keygen());
process.exit(signPackage());
