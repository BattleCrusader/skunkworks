/**
 * The Australian PII rules, executable.
 *
 * `app/accounts/pii.ts` is the control; `docs/privacy/pii-australia.md` is the position it
 * implements. This file is the proof, and — like `test/accounts-policy.test.ts` — it is written so
 * that a well-meaning loosening fails here rather than in production. Each block names the rule it
 * pins:
 *
 *   S  the four refusals, by the shape each one catches;
 *   R  redaction keeps the sentence and loses the detail;
 *   N  the locality bound: the four accepted forms the product promises, and the addresses that
 *      must not fit through it;
 *   F  the false positives that would make the gate unusable — ordinary role text, health-tech and
 *      disability-support vocabulary, a business number, an ordinal, a police check;
 *   B  the robustness floor: empty, 10 000 characters, unicode, and the module's own purity.
 *
 * The counts are not the point; the named failures are. A gate that refuses a fractional CTO's
 * one-line pitch is a gate an operator turns off, and then nothing is screened at all.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  AU_STATES,
  normaliseSuburbCity,
  redactFreeText,
  screenFreeText,
  type LocalityResult,
  type ScreenReason,
  type ScreenResult,
} from '../app/accounts/pii.ts';
import { REPO } from './helpers/fixture.ts';

/** The reason a screen refused, or a failed assertion naming what was accepted instead. */
function refusal(result: ScreenResult): ScreenReason {
  if (result.ok) assert.fail(`expected a refusal, got ok with ${JSON.stringify(result.value)}`);
  return result.reason;
}

/** The value a screen accepted, or a failed assertion naming why it did not. */
function accepted(result: ScreenResult): string {
  if (!result.ok) assert.fail(`expected acceptance, refused for ${result.reason}`);
  return result.value;
}

function locality(result: LocalityResult): string {
  if (!result.ok) assert.fail(`expected a locality, refused for ${result.reason}`);
  return result.value;
}

function localityRefusal(result: LocalityResult): string {
  if (result.ok) assert.fail(`expected a refusal, got locality ${JSON.stringify(result.value)}`);
  return result.reason;
}

// --- S: the four refusals --------------------------------------------------------------------

test('S1 — an email address is refused, and the reason is `email`', () => {
  assert.equal(refusal(screenFreeText('jane@example.com')), 'email');
  assert.equal(refusal(screenFreeText('Reply to me: Jane.Doe+fractional@sub.example.com.au')), 'email');
  // Obfuscated: the form a person uses when a form refuses the plain one.
  assert.equal(refusal(screenFreeText('jane (at) example (dot) com')), 'email');
  assert.equal(refusal(screenFreeText('jane at example dot com')), 'email');
});

test('S2 — an Australian mobile is refused in every form a person writes it', () => {
  for (const phone of ['call me on 0412 345 678', '0412-345-678', '0412345678', '+61 412 345 678', '+61412345678']) {
    assert.equal(refusal(screenFreeText(phone)), 'phone', phone);
  }
});

test('S3 — a landline with an area code is refused, bracket and all', () => {
  for (const phone of ['(02) 9123 4567', '02 9123 4567', '0291234567', '+61 2 9123 4567', '03 9000 1234']) {
    assert.equal(refusal(screenFreeText(phone)), 'phone', phone);
  }
});

test('S4 — a phone number is not refused merely for containing digits', () => {
  // An ABN, a year, a price, an IP and a version string are all digit runs. None is a phone.
  const ordinary = [
    'ABN 12 345 678 901',
    'between 2019 and 2024',
    '$120,000 a year',
    '10.0.0.1 is the appliance',
    'v2.14.1 shipped in March',
    'a team of 12 across 3 time zones',
  ];
  for (const text of ordinary) assert.equal(accepted(screenFreeText(text)), text);
});

test('S5 — a street address is refused: number, then a street-type word', () => {
  assert.equal(refusal(screenFreeText('Unit 3, 12 Smith St')), 'address');
  assert.equal(refusal(screenFreeText('I live at 47 George Street, Brisbane')), 'address');
  assert.equal(refusal(screenFreeText('5 Marine Pde, Manly')), 'address');
  assert.equal(refusal(screenFreeText('Level 4, 100 Harris Rd')), 'address');
});

test('S6 — a postal address is refused even though it has no street', () => {
  assert.equal(refusal(screenFreeText('write to PO Box 55')), 'address');
  assert.equal(refusal(screenFreeText('GPO Box 1234, Sydney')), 'address');
});

test('S7 — sensitive-category disclosures are refused, one per s 6 class', () => {
  const disclosures: readonly [ScreenReason, string][] = [
    ['sensitive', 'I have a chronic health condition'],
    ['sensitive', 'my health issues make full-time hard'],
    ['sensitive', 'I was diagnosed with MS in 2019'],
    ['sensitive', "I'm a Christian"],
    ['sensitive', 'my religion shapes how I lead'],
    ['sensitive', "I'm gay"],
    ['sensitive', 'my political views are my own'],
    ['sensitive', 'I have a criminal record'],
    ['sensitive', 'convicted of a minor offence in 2015'],
    // A denial is still a statement about a criminal record, and a cover note is not where that
    // belongs. Refused deliberately, and named here so the behaviour is a decision, not a quirk.
    ['sensitive', 'I have no criminal record either'],
  ];
  for (const [reason, text] of disclosures) assert.equal(refusal(screenFreeText(text)), reason, text);
});

test('S8 — the identifiers APP 3 never makes necessary are refused by name', () => {
  const identifiers = [
    'my date of birth is 12/03/1980',
    'd.o.b 12/03/1980',
    'TFN: 123 456 789',
    'my tfn is 123 456 789',
    'Medicare number 2123 45678 1',
    'passport number PA1234567',
  ];
  for (const text of identifiers) assert.equal(refusal(screenFreeText(text)), 'sensitive', text);
});

test('S9 — the first matching rule wins, in one fixed order, so an answer is deterministic', () => {
  // Email is checked before address and phone, so a note containing all three reports `email`.
  const all = 'jane@example.com, 0412 345 678, 12 Smith St';
  for (let i = 0; i < 5; i += 1) assert.equal(refusal(screenFreeText(all)), 'email');
});

// --- R: redaction ---------------------------------------------------------------------------

test('R1 — redaction removes the contact detail and leaves the sentence readable', () => {
  const redacted = redactFreeText('Email jane@example.com or call 0412 345 678, thanks.');
  assert.equal(redacted, 'Email [removed] or call [removed], thanks.');
  assert.ok(!redacted.includes('jane@example.com'));
  assert.ok(redacted.startsWith('Email '));
  assert.ok(redacted.endsWith(', thanks.'));
});

test('R2 — an address is redacted without destroying the words around it', () => {
  const redacted = redactFreeText('I live at 12 Smith St, Newcastle, and I can start Monday.');
  assert.equal(redacted, 'I live at [removed], Newcastle, and I can start Monday.');
});

test('R3 — a bracketed landline is redacted with its bracket, not half of one', () => {
  const redacted = redactFreeText('Ring the office on (02) 9123 4567 or 1300 123 456.');
  assert.equal(redacted, 'Ring the office on [removed] or 1300 123 456.');
});

test('R4 — redaction is idempotent and leaves clean text alone', () => {
  const clean = 'Fractional CTO, 2 days a week, remote-first, deep payments experience';
  assert.equal(redactFreeText(clean), clean);
  const once = redactFreeText('call 0412 345 678');
  assert.equal(redactFreeText(once), once);
});

// --- N: the locality bound ------------------------------------------------------------------

test('N1 — the four forms the product promises are accepted', () => {
  assert.equal(locality(normaliseSuburbCity('Newcastle')), 'Newcastle');
  assert.equal(locality(normaliseSuburbCity('Newcastle NSW')), 'Newcastle NSW');
  assert.equal(locality(normaliseSuburbCity('Melbourne, VIC')), 'Melbourne VIC');
  assert.equal(locality(normaliseSuburbCity('Surry Hills NSW 2010')), 'Surry Hills NSW 2010');
});

test('N2 — the comma is punctuation, and the state is a closed vocabulary', () => {
  assert.equal(locality(normaliseSuburbCity('melbourne, vic')), 'melbourne VIC');
  assert.equal(locality(normaliseSuburbCity('  Surry   Hills ,  nsw , 2010 ')), 'Surry Hills NSW 2010');
  assert.equal(locality(normaliseSuburbCity('Sydney New South Wales 2000')), 'Sydney NSW 2000');
});

test('N3 — a street address is refused, and the reason names the street', () => {
  for (const address of ['12 Smith Street', 'Unit 4/12 Smith St', 'PO Box 55', '123 Somewhere Rd', 'Smith Street', 'Main Rd Bentleigh']) {
    assert.equal(localityRefusal(normaliseSuburbCity(address)), 'street', address);
  }
});

test('N4 — a house number is refused even when there is no street word', () => {
  for (const text of ['12 Sydney', 'Unit 4 Newcastle', 'Sydney NSW 200', 'Sydney NSW 2000 extra', 'Sydney 0000']) {
    assert.equal(localityRefusal(normaliseSuburbCity(text)), 'digits', text);
  }
});

test('N5 — 80 characters is the bound, and a locality never needs it', () => {
  assert.equal(localityRefusal(normaliseSuburbCity('A'.repeat(81))), 'too-long');
  assert.equal(locality(normaliseSuburbCity('Tweed Heads South NSW 2486')), 'Tweed Heads South NSW 2486');
});

test('N6 — suburbs whose names begin with a street-type word are still suburbs', () => {
  // "St Kilda", "St Peters" and "Lane Cove" are the collisions that make a naive street check
  // wrong for a Melbourne or Sydney user. The exemption is position 0 only, which N3 pins.
  assert.equal(locality(normaliseSuburbCity('St Kilda VIC')), 'St Kilda VIC');
  assert.equal(locality(normaliseSuburbCity('St Peters NSW 2044')), 'St Peters NSW 2044');
  assert.equal(locality(normaliseSuburbCity('Lane Cove NSW')), 'Lane Cove NSW');
  assert.equal(locality(normaliseSuburbCity("O'Halloran Hill SA")), "O'Halloran Hill SA");
});

test('N7 — an empty location is not an error: it means "not given"', () => {
  assert.equal(locality(normaliseSuburbCity('')), '');
  assert.equal(locality(normaliseSuburbCity('   ')), '');
});

test('N8 — a state on its own is not a locality', () => {
  assert.equal(localityRefusal(normaliseSuburbCity('NSW')), 'digits');
  assert.equal(localityRefusal(normaliseSuburbCity('2010')), 'digits');
});

// --- F: the false positives that would make the gate unusable ------------------------------

test('F1 — ordinary role text passes screening unchanged, byte for byte', () => {
  const pitch = 'Fractional CTO, 2 days a week, remote-first, deep payments experience';
  const result = screenFreeText(pitch);
  assert.equal(accepted(result), pitch);
  assert.equal(accepted(result).length, pitch.length);
});

test('F2 — a health, disability or clinical *domain* is not a health disclosure', () => {
  const ordinary = [
    'Health-tech product manager, clinical trials platform',
    'disability support worker for 6 years',
    'I led the mental health services redesign at a state agency',
    'clinical governance, medication safety, aged care',
    'indigenous engagement and community consultation',
  ];
  for (const text of ordinary) assert.equal(accepted(screenFreeText(text)), text);
});

test('F3 — a business number is not personal information', () => {
  assert.equal(accepted(screenFreeText('our support line is 1300 123 456')), 'our support line is 1300 123 456');
  assert.equal(accepted(screenFreeText('1800 555 000 for the service desk')), '1800 555 000 for the service desk');
});

test('F4 — an ordinal is not a house number, and a count is not a street', () => {
  const ordinary = [
    'I finished 2nd place at a hackathon',
    '1st hire in the Sydney office',
    '3 ways to ship faster',
    '2 days a week on site',
    'I have run 12 squads across 4 countries',
  ];
  for (const text of ordinary) assert.equal(accepted(screenFreeText(text)), text);
});

test('F5 — a police check is a hiring requirement, not a criminal record', () => {
  const text = 'I hold a current national police check and can provide a criminal record check on request';
  assert.equal(accepted(screenFreeText(text)), text);
});

test('F6 — an ordinary licence is a credential; only a licence *number* is an identifier', () => {
  assert.equal(accepted(screenFreeText('I hold a full driver licence')), 'I hold a full driver licence');
  assert.equal(refusal(screenFreeText('driver licence number 1234567')), 'sensitive');
});

// --- B: the robustness floor ----------------------------------------------------------------

test('B1 — nothing throws on empty input, and empty is a pass with an empty value', () => {
  assert.equal(accepted(screenFreeText('')), '');
  assert.equal(locality(normaliseSuburbCity('')), '');
  assert.equal(redactFreeText(''), '');
});

test('B2 — nothing throws or stalls on 10 000 characters', () => {
  const long = 'a'.repeat(10_000);
  assert.equal(accepted(screenFreeText(long)), long);
  assert.equal(redactFreeText(long), long);
  assert.equal(localityRefusal(normaliseSuburbCity(long)), 'too-long');

  // The pathological shapes a regex is usually wrong about: a local part with no domain, a digit
  // run, and a dot run. All three must answer. No wall-clock assertion here — `make test` asserts
  // correctness only, and a timing number on a shared box measures the box. What a catastrophic
  // backtrack would do instead is blow the runner's per-test timeout, which fails this file by name.
  assert.equal(screenFreeText(`${'a.'.repeat(5_000)}@`).ok, true);
  assert.equal(screenFreeText('1'.repeat(10_000)).ok, true);
  assert.ok(redactFreeText(`${'a.'.repeat(5_000)}@`).length > 0);
});

test('B3 — unicode passes through screening and redaction unchanged', () => {
  const text = 'Ünïcödé — 日本語 — emoji 🚀 — e\u0301 combining, Züri';
  assert.equal(accepted(screenFreeText(text)), text);
  assert.equal(redactFreeText(text), text);
  // A unicode locality is not refused for being unicode: the bound is digits, not alphabet.
  assert.equal(accepted(screenFreeText('São Paulo (remote)')), 'São Paulo (remote)');
});

test('B4 — the module is pure: no imports, no clock, no database, no route', () => {
  const source = readFileSync(join(REPO, 'app', 'accounts', 'pii.ts'), 'utf8');
  const forbidden: readonly [RegExp, string][] = [
    [/^\s*import\s/m, 'an import statement'],
    [/\bimport\s*\(/, 'a dynamic import'],
    [/\brequire\s*\(/, 'require()'],
    [/\bprocess\./, 'process'],
    [/\bDate\.now\b|\bnew Date\s*\(/, 'the clock'],
    [/\bMath\.random\b/, 'randomness'],
    [/better-sqlite3/, 'a database driver'],
    [/\bfastify\b/, 'an HTTP framework'],
  ];
  for (const [pattern, what] of forbidden) {
    assert.equal(pattern.test(source), false, `app/accounts/pii.ts contains ${what}: the screen must be a pure function of its input`);
  }
});

test('B5 — AU_STATES is the closed, frozen vocabulary the locality check validates against', () => {
  assert.deepEqual([...AU_STATES], ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA']);
  assert.equal(Object.isFrozen(AU_STATES), true);
  assert.equal(new Set(AU_STATES).size, AU_STATES.length);
  for (const state of AU_STATES) {
    assert.equal(locality(normaliseSuburbCity(`Newcastle ${state}`)), `Newcastle ${state}`);
  }
  // A ninth abbreviation is not a state, so it stays in the locality and the value is unchanged.
  assert.equal(locality(normaliseSuburbCity('Newcastle NZ')), 'Newcastle NZ');
});
