/**
 * D1 — **the install screen must tell the truth about capabilities** (E-33 item 6, §13.3.7).
 *
 * The screen is the only surface on which the trust decision §8.5/§13.3.7 defines is made, and
 * until this file existed it said three false things about a package with no declared
 * capabilities:
 *
 *   1. `none — it can reach neither this site's data nor its mailer`. In-process that is false:
 *      a plugin can `import('better-sqlite3')`, open `data/control.db` and read every tenant,
 *      or open a socket and send mail itself. Capabilities are disclosure, not containment.
 *   2. the one sentence E-33 item 6 requires was absent, and so was the gate for it. The
 *      sentence is *not* copied into this file as a literal that can drift: it is parsed out of
 *      `docs/sds/02-errata.md` and compared with the constant below, so an errata edit that
 *      moves the wording fails here until the screen moves with it.
 *   3. the screen still spoke the retired architecture — "the runner scans … restart the runner
 *      service" — for a runner service D36 deleted. An operator would go looking for it.
 *
 *   P1  a real `skwctl plugin install` prints E-33's sentence, verbatim, on one line
 *   P2  a zero-capability package is described as asking for nothing — never as unable to
 *       reach this site's data or its mailer
 *   P3  no operator-facing string on install, enable or uninstall mentions a runner (and none
 *       of the three carries a service claim), asserted over the real process output
 *   P4  the source scan that backs P3 is itself checked: a live service claim is flagged, a
 *       comment is flagged unless the named allowlist holds it, and an allowlisted comment is
 *       accepted — a grep that cannot fail is a comment
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { packageRootHash } from '../app/plugins/manifest.ts';
import { REPO, makeFixture, type Fixture } from './helpers/fixture.ts';

const CLI = join(REPO, 'app', 'cli', 'skwctl.ts');
const TENANT = 'acme';
const NOTHING = join(REPO, 'test', 'fixtures', 'plugins', 'nothing');
const ERRATA = join(REPO, 'docs', 'sds', '02-errata.md');
const DIGEST = 'sha256:d1-install-screen';

/**
 * E-33 item 6 / `SDS.md` §13.3.7's drop-in, as one line. P1 proves this equals what the errata
 * says before it proves the product prints it, so the gate is tied to the errata's bytes.
 */
const SENTENCE =
  "Capabilities describe what this plugin asks the CMS for. They do not limit what its code can do: a plugin runs inside the site's process, with the site's own access to its files and databases.";

/** The claim D1 found on the screen, in the two shapes it can take. */
const FALSE_CLAIM = /can reach neither|nor its mailer|cannot reach|cannot send (?:mail|email)|has no access to (?:this site|site data)/i;

/**
 * A **runner service** claim: a process, a scan, a log, an image, a restart. `runner_image_digest`
 * (the test report's artifact field) and `--runner-digest` (its flag) are not service claims and
 * do not match: both are one word with an underscore or a hyphen, never "runner <noun>".
 */
const RUNNER_SERVICE =
  /runner[\s-]+(?:service|scans?|log|container|image|process|daemon|socket)\b|restart\s+the\s+runner|the\s+runner\s+(?:scans|holds|refuses|loads|will|is)\b/i;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function skwctl(env: Record<string, string>, args: readonly string[]): Run {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd: REPO, env: { ...env }, encoding: 'utf8', timeout: 60_000 });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** The sentence as the errata writes it, joined across its line break. */
function sentenceFromErrata(): string {
  const text = readFileSync(ERRATA, 'utf8');
  const match = /\*"(Capabilities describe[\s\S]*?databases\.)"\*/.exec(text);
  assert.ok(match !== null, `${ERRATA} no longer carries E-33 item 6's quoted sentence — this gate has lost its source`);
  return (match[1] as string)
    .split('\n')
    .map((line) => line.trim())
    .join(' ');
}

interface Hit {
  file: string;
  line: number;
  text: string;
  comment: boolean;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/**
 * Every line of `source` that reads as a runner-service claim. Comments are returned too, marked
 * as such, because §13.1a's lesson is that a stale sentence in a comment is read by the next
 * builder as a description of the product — the allowlist is how a *historical* one is named and
 * kept, and how a new one is refused.
 */
function scanRunnerService(file: string, source: string): Hit[] {
  const hits: Hit[] = [];
  source.split('\n').forEach((line, index) => {
    if (RUNNER_SERVICE.test(line)) hits.push({ file, line: index + 1, text: line.trim(), comment: isCommentLine(line) });
  });
  return hits;
}

/**
 * The named allowlist. One entry: the comment on `TestReport.runner_image_digest` that explains
 * why that field keeps its D36-era name (it is a wire format the packager writes and
 * `bundle_verify` reads). Everything else runner-era on these three files was rewritten in the
 * D1 fix, and a *new* comment fails P4 until someone classifies it here with a reason. An entry
 * is `{ file, contains, why }` — a file and a substring, not a line number, because a line
 * number is wrong the next time somebody adds an import.
 */
const COMMENT_ALLOWLIST: { file: string; contains: string; why: string }[] = [
  {
    file: join(REPO, 'app', 'plugins', 'install.ts'),
    contains: 'the runner service is gone',
    why: 'names the deleted service only to explain why runner_image_digest keeps its name — a wire format, not a UI string',
  },
];

function allowedByList(hit: Hit): boolean {
  return COMMENT_ALLOWLIST.some((entry) => entry.file === hit.file && hit.text.includes(entry.contains));
}

const SCANNED = [
  join(REPO, 'app', 'cli', 'skwctl.ts'),
  join(REPO, 'app', 'plugins', 'install.ts'),
  join(REPO, 'app', 'plugins', 'trust.ts'),
];

let fixture: Fixture;
let installed: Run;
let enabled: Run;
let uninstalled: Run;

before(() => {
  fixture = makeFixture({ specs: [{ key: TENANT, hosts: ['acme.test'], title: 'Acme' }] });
  const root = packageRootHash(NOTHING).root;
  const report = join(fixture.dir, 'nothing-report.json');
  writeFileSync(
    report,
    `${JSON.stringify(
      { plugin: 'nothing', version: '1.0.0', root_hash: root, runner_image_digest: DIGEST, ran_at: '2026-10-21T00:00:00.000Z' },
      null,
      2,
    )}\n`,
  );
  installed = skwctl(fixture.env, [
    'plugin',
    'install',
    NOTHING,
    '--tenant',
    TENANT,
    '--allow-unsigned',
    '--test-report',
    report,
    '--runner-digest',
    DIGEST,
  ]);
  enabled = skwctl(fixture.env, ['plugin', 'enable', 'nothing', '--tenant', TENANT]);
  uninstalled = skwctl(fixture.env, ['plugin', 'uninstall', 'nothing', '--tenant', TENANT]);
});

after(() => {
  fixture.cleanup();
});

test('P0 — the real install, enable and uninstall each succeed, so the strings below are the product’s', () => {
  assert.equal(installed.status, 0, `install failed:\nSTDOUT:\n${installed.stdout}\nSTDERR:\n${installed.stderr}`);
  assert.match(installed.stdout, /install screen — nothing@1\.0\.0/, installed.stdout);
  assert.match(installed.stdout, /capabilities/, 'the screen must have a capabilities line at all');
  assert.equal(enabled.status, 0, `enable failed:\n${enabled.stdout}\n${enabled.stderr}`);
  assert.equal(uninstalled.status, 0, `uninstall failed:\n${uninstalled.stdout}\n${uninstalled.stderr}`);
});

test("P1 — the install screen carries E-33 item 6's sentence verbatim, and the sentence is the errata's", () => {
  assert.equal(sentenceFromErrata(), SENTENCE, 'the errata and this gate disagree about the wording: move both together');
  assert.ok(
    installed.stdout.includes(SENTENCE),
    `the install screen does not carry E-33 item 6's sentence on one line.\nWANTED (verbatim):\n${SENTENCE}\nGOT:\n${installed.stdout}`,
  );
});

test('P2 — a zero-capability package asks for nothing; it is never described as unable to reach site data', () => {
  const capabilities = installed.stdout.split('\n').filter((line) => /capabilities|what this means/i.test(line)).join('\n');
  assert.ok(capabilities.length > 0, 'the screen printed no capabilities section');
  assert.doesNotMatch(
    capabilities,
    FALSE_CLAIM,
    `the screen still claims containment it does not have:\n${capabilities}\n(A plugin can open data/control.db with its own better-sqlite3 handle — §13.3.7, §13.4 item 5.)`,
  );
  assert.match(capabilities, /none declared/, `the zero-capability line must say what is true — that nothing is declared:\n${capabilities}`);
});

test('P3 — no operator-facing string on install, enable or uninstall mentions a runner', () => {
  const all = `--- install ---\n${installed.stdout}${installed.stderr}\n--- enable ---\n${enabled.stdout}${enabled.stderr}\n--- uninstall ---\n${uninstalled.stdout}${uninstalled.stderr}`;
  assert.doesNotMatch(
    all,
    /runner/i,
    `the operator path still speaks of a runner that D36 deleted:\n${all
      .split('\n')
      .filter((line) => /runner/i.test(line))
      .join('\n')}`,
  );
});

test('P4 — the source scan behind P3 can fail: a live claim is flagged, a comment needs the allowlist', () => {
  const live = scanRunnerService('synthetic.ts', "  ctx.stdout('plugin: restart the runner service to load nothing');");
  assert.equal(live.length, 1, 'a live runner-service string was not flagged');
  assert.equal(live[0]?.comment, false);

  const comment = scanRunnerService('synthetic.ts', '    // The runner scans <data>/plugins at start and holds the list.');
  assert.equal(comment.length, 1, 'a runner-service comment was not flagged');
  assert.equal(comment[0]?.comment, true);
  assert.equal(allowedByList(comment[0] as Hit), false, 'nothing may be excused unless the allowlist names its file and text');

  const allowlisted = { file: 'synthetic.ts', contains: 'The runner scans', why: 'a historical note this round deliberately keeps' };
  COMMENT_ALLOWLIST.push(allowlisted);
  try {
    assert.equal(allowedByList(comment[0] as Hit), true, 'the named allowlist does not admit the entry it names');
  } finally {
    COMMENT_ALLOWLIST.pop();
  }

  // …and the identifiers that are *not* service claims must not be flagged, or this gate would
  // force a rename that has nothing to do with the defect.
  assert.equal(scanRunnerService('synthetic.ts', "  test_report: { runner_image_digest: string };").length, 0);
  assert.equal(scanRunnerService('synthetic.ts', "    '--runner-digest',").length, 0);

  // The real files: no live claim, and no unlisted comment.
  const hits = SCANNED.flatMap((file) => scanRunnerService(file, readFileSync(file, 'utf8')));
  const live_ = hits.filter((hit) => !hit.comment);
  assert.deepEqual(
    live_.map((hit) => `${hit.file}:${hit.line}: ${hit.text}`),
    [],
    'an operator-facing string still reads as a runner service',
  );
  const unlisted = hits.filter((hit) => hit.comment && !allowedByList(hit));
  assert.deepEqual(
    unlisted.map((hit) => `${hit.file}:${hit.line}: ${hit.text}`),
    [],
    'a runner-era comment is not in COMMENT_ALLOWLIST — classify it (with a reason) or rewrite it',
  );
});
