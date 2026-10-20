/**
 * schema/error-codes.json stays the authority (§4.3) even though the app keeps
 * a compile-time map: this test fails when the two disagree, so a new code or a
 * changed status cannot go unnoticed.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { AppError, CODE_PATTERN, HTTP, RETRY_AFTER, errorBody } from '../app/errors.ts';
import { REPO } from './helpers/fixture.ts';

interface Codes {
  pattern: string;
  http: Record<string, number>;
  retry_after?: Record<string, number>;
  areas: Record<string, string[]>;
}

const codes = JSON.parse(readFileSync(join(REPO, 'schema', 'error-codes.json'), 'utf8')) as Codes;

test('the app pattern is the frozen pattern', () => {
  assert.equal(CODE_PATTERN.source, codes.pattern);
});

test('every code the app can raise exists in the JSON, with the same status', () => {
  for (const [code, status] of Object.entries(HTTP)) {
    assert.equal(codes.http[code], status, `${code} disagrees with schema/error-codes.json`);
  }
  // Both directions. The one-way check above let sixteen frozen codes (five RT, six EXP,
  // five PL) live in the JSON and not in the app map, so an AppError for any of them threw
  // "no HTTP mapping" at the moment it was raised. The mirror is the gate.
  for (const code of Object.keys(codes.http)) {
    assert.equal(typeof HTTP[code], 'number', `${code} is frozen in schema/error-codes.json but the app has no mapping`);
  }
});

test('every Retry-After the app sends is the frozen value', () => {
  for (const [code, seconds] of Object.entries(RETRY_AFTER)) {
    assert.equal(codes.retry_after?.[code], seconds, `${code} retry_after disagrees`);
  }
});

test('the codes S1 raises are all mapped, and the four E-4 additions are part of the taxonomy', () => {
  for (const code of [
    'SKW_E_PLT_EDGE_PROOF',
    'SKW_E_PLT_TENANT_HEADER',
    'SKW_E_PLT_TENANT_UNKNOWN',
    'SKW_E_PLT_TENANT_UNAVAILABLE',
    'SKW_E_DM_SCHEMA_STALE',
    'SKW_E_RT_PAGE_NOT_FOUND',
    'SKW_E_PLT_INTERNAL',
    'SKW_E_PLT_REQUEST_INVALID',
    'SKW_E_PLT_BODY_TOO_LARGE',
  ]) {
    assert.equal(typeof HTTP[code], 'number');
    assert.equal(HTTP[code], codes.http[code], `${code} disagrees with the JSON`);
  }
  // E-16: 71 -> 72 codes (AUTH_INVALID), and none of the four E-4 additions carries
  // a Retry-After. The count is the gate: the app map, the JSON and this number move
  // together or the suite is red.
  // S4a-fix: 75 -> 76 — COMPONENT_INVENTORY, the save path's refusal when the canvas's
  // inventory and the locks in the bytes it is about to store disagree.
  // S4b: 76 -> 78 — EXP BODY_UNNORMALISABLE and ASSET_UNRESOLVED, the projection's two
  // refusals for a stored row that cannot become a page (never a skipped page).
  // S4c: 78 -> 80 — EXP WRITER_ACTIVE and PL EXPORT_PACKAGE_MISSING: two writers on one
  // tenant, and a plugin row whose package the bundle does not carry.
  const total = Object.values(codes.areas).reduce((n, names) => n + names.length, 0);
  assert.equal(total, 80, `the taxonomy holds ${total} codes, expected 80 (S4c: EXP WRITER_ACTIVE, PL EXPORT_PACKAGE_MISSING)`);
  for (const code of ['SKW_E_RT_PAGE_NOT_FOUND', 'SKW_E_PLT_INTERNAL', 'SKW_E_PLT_REQUEST_INVALID', 'SKW_E_PLT_BODY_TOO_LARGE']) {
    assert.equal(codes.retry_after?.[code], undefined, `${code} must not carry Retry-After`);
  }
});

test('E-16: a credential login failure has its own code, 401, and no Retry-After', () => {
  // The code exists in the frozen JSON, in the SEC area, mapped to 401.
  assert.ok(codes.areas.SEC?.includes('AUTH_INVALID'), 'AUTH_INVALID must be in areas.SEC');
  assert.equal(codes.http['SKW_E_SEC_AUTH_INVALID'], 401);
  assert.equal(HTTP['SKW_E_SEC_AUTH_INVALID'], 401);
  assert.equal(codes.retry_after?.['SKW_E_SEC_AUTH_INVALID'], undefined);
  assert.equal(RETRY_AFTER['SKW_E_SEC_AUTH_INVALID'], undefined);
  // CODE_INVALID keeps its own meaning and its own row: the two must not collapse.
  assert.equal(codes.http['SKW_E_SEC_CODE_INVALID'], 401);
  assert.notEqual('SKW_E_SEC_AUTH_INVALID', 'SKW_E_SEC_CODE_INVALID');
});

test('E-16: the split is real — a download code still raises CODE_INVALID, and the admin surface cannot raise it', () => {
  // §7.2's decision, still constructible with its own code and status.
  const downloadCode = new AppError('SKW_E_SEC_CODE_INVALID', 'invalid credentials');
  assert.equal(downloadCode.code, 'SKW_E_SEC_CODE_INVALID');
  assert.equal(downloadCode.status, 401);
  const login = new AppError('SKW_E_SEC_AUTH_INVALID', 'invalid credentials');
  const bodyOf = (err: AppError): string =>
    JSON.stringify(errorBody(err, 'r')).replace(/"code":"[^"]+"/, '"code":"<code>"');
  assert.equal(
    bodyOf(downloadCode),
    bodyOf(login),
    'the bodies differ only in the code, which is what makes one counter per decision possible',
  );
  assert.equal(errorBody(downloadCode, 'r').error.code, 'SKW_E_SEC_CODE_INVALID');
  assert.equal(errorBody(login, 'r').error.code, 'SKW_E_SEC_AUTH_INVALID');

  // The structural half: no file under app/admin raises the download code, so the
  // login path cannot emit it by accident (that is what S2a did).
  const dir = join(REPO, 'app', 'admin');
  const offenders: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts')) continue;
    const text = readFileSync(join(dir, name), 'utf8');
    if (text.includes("AppError('SKW_E_SEC_CODE_INVALID'")) offenders.push(name);
  }
  assert.deepEqual(offenders, [], 'the admin surface must not raise the paid-download code');
});
