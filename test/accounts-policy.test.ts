/**
 * The PII matrix, executable.
 *
 * `policy.ts` is the single place that decides what a viewer may see. This file is the proof that
 * it decides correctly, and — more importantly — that it cannot quietly start deciding something
 * else: the key-set assertion at the bottom fails if *any* future field is added to a projection,
 * so a PII field cannot be introduced by a well-meaning refactor.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  matchesJobSkills,
  mayNotify,
  mayShareContact,
  projectProfile,
  type ApplicantProfile,
  type Viewer,
} from '../app/accounts/policy.ts';

function profile(over: Partial<ApplicantProfile> = {}): ApplicantProfile {
  return {
    accountId: 41,
    displayName: 'Sam Rivera',
    headline: 'Staff engineer, payments',
    summary: 'Fifteen years of distributed systems.',
    skills: ['TypeScript', 'Postgres'],
    hourlyRateCents: 9_550,
    currency: 'AUD',
    availabilityDaysPerWeek: 3,
    location: 'Newcastle, NSW',
    timezone: 'Australia/Sydney',
    workModes: ['hybrid'],
    links: [{ label: 'Portfolio', url: 'https://example.test/sam' }],
    visibility: 'discoverable',
    notifyNewJobs: true,
    status: 'active',
    ...over,
  };
}

const applicant = (over: Partial<ApplicantProfile> = {}): ApplicantProfile => profile(over);
const ADVERTISER_SHARED: Viewer = { kind: 'advertiser', companyId: 7, shares: true };

test('P1 — the holder sees their own profile, including while it is pending', () => {
  for (const status of ['pending', 'active', 'suspended', 'closed'] as const) {
    const got = projectProfile({ kind: 'self' }, applicant({ status }));
    assert.notEqual(got, null, `${status} must be visible to its own holder`);
    assert.equal(got?.basis, 'self');
    assert.equal(got?.displayName, 'Sam Rivera');
  }
});

test('P2 — the tenant operator sees it (the caller audits that access)', () => {
  const got = projectProfile({ kind: 'operator' }, applicant());
  assert.equal(got?.basis, 'operator');
});

test('P3 — an anonymous viewer sees nothing, always', () => {
  assert.equal(projectProfile({ kind: 'public' }, applicant()), null);
  assert.equal(projectProfile({ kind: 'public' }, applicant({ status: 'pending' })), null);
});

test('P4 — discoverable is not a grant: an advertiser without an application sees nothing', () => {
  assert.equal(projectProfile({ kind: 'advertiser', companyId: 7, shares: false }, applicant()), null);
});

test('P5 — an application is the grant, and the projection is what the applicant chose to show', () => {
  const got = projectProfile(ADVERTISER_SHARED, applicant());
  assert.equal(got?.basis, 'application');
  assert.equal(got?.headline, 'Staff engineer, payments');
  assert.deepEqual(got?.skills, ['TypeScript', 'Postgres']);
  assert.equal(got?.hourlyRateCents, 9_550);
  assert.deepEqual(got?.workModes, ['hybrid']);
});

test('P6 — a hidden profile is still visible to the advertiser the applicant applied to', () => {
  // `hidden` governs discovery and mail, not a disclosure the person made deliberately.
  const got = projectProfile(ADVERTISER_SHARED, applicant({ visibility: 'hidden' }));
  assert.notEqual(got, null);
  assert.equal(mayNotify(applicant({ visibility: 'hidden' })), false);
});

test('P7 — a shape that cannot be scoped is refused, not treated as "some company"', () => {
  for (const companyId of [0, -1, Number.NaN, 1.5]) {
    assert.equal(
      projectProfile({ kind: 'advertiser', companyId, shares: true }, applicant()),
      null,
      `companyId ${String(companyId)} must not be accepted`,
    );
  }
});

test('P8 — pending, suspended and closed accounts are invisible to advertisers even with an application', () => {
  for (const status of ['pending', 'suspended', 'closed'] as const) {
    assert.equal(projectProfile(ADVERTISER_SHARED, applicant({ status })), null, status);
  }
});

test('P9 — no projection carries an address, an id, or an internal flag', () => {
  const forbidden = /email|phone|address|accountid|visibility|notify|status|secret|hash/i;
  const viewers: Viewer[] = [{ kind: 'self' }, { kind: 'operator' }, ADVERTISER_SHARED];
  for (const viewer of viewers) {
    const got = projectProfile(viewer, applicant());
    assert.notEqual(got, null);
    for (const key of Object.keys(got ?? {})) {
      assert.equal(forbidden.test(key), false, `projection for ${viewer.kind} exposes ${key}`);
    }
  }
  // The key set is asserted exactly. Adding a field to a projection is a privacy decision and
  // must be made here, in this list, with a reviewer looking at it.
  assert.deepEqual(Object.keys(projectProfile({ kind: 'self' }, applicant()) ?? {}).sort(), [
    'availabilityDaysPerWeek',
    'basis',
    'currency',
    'displayName',
    'headline',
    'hourlyRateCents',
    'links',
    'location',
    'skills',
    'summary',
    'timezone',
    'workModes',
  ]);
});

test('P10 — contact is never shared, through any viewer', () => {
  for (const viewer of [{ kind: 'self' }, { kind: 'operator' }, ADVERTISER_SHARED, { kind: 'public' }] as Viewer[]) {
    assert.equal(mayShareContact(viewer), false);
  }
});

test('P11 — a projection is a copy; a caller cannot mutate the record through it', () => {
  const source = applicant();
  const got = projectProfile({ kind: 'self' }, source);
  assert.notEqual(got, null);
  (got?.skills as string[]).push('Hacked');
  (got?.links as { label: string; url: string }[]).push({ label: 'x', url: 'https://evil.test' });
  assert.deepEqual([...source.skills], ['TypeScript', 'Postgres']);
  assert.equal(source.links.length, 1);
});

test('P12 — mail is opt-in, discoverable, and active; all three, or nothing', () => {
  assert.equal(mayNotify(applicant()), true);
  assert.equal(mayNotify(applicant({ notifyNewJobs: false })), false, 'no opt-in, no mail');
  assert.equal(mayNotify(applicant({ visibility: 'hidden' })), false, 'hidden profiles are not mailed');
  assert.equal(mayNotify(applicant({ status: 'pending' })), false, 'unactivated accounts are not mailed');
});

test('P13 — skill matching is conservative, case-insensitive, and stated once', () => {
  const p = applicant({ skills: [' TypeScript ', 'postgres'] });
  assert.equal(matchesJobSkills(p, []), true, 'a job with no declared skills is open work');
  assert.equal(matchesJobSkills(p, ['typescript']), true);
  assert.equal(matchesJobSkills(p, ['POSTGRES', 'Rust']), true);
  assert.equal(matchesJobSkills(p, ['rust']), false);
  assert.equal(matchesJobSkills(p, ['   ']), true, 'blank entries are not a filter');
});
