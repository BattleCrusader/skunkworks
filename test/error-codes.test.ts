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
  // S4e: 80 -> 82 — RT REPEAT_INVALID (a `list` with two `[data-repeat]` children) and
  // PL OOM (the runner cgroup killed a package's child).
  // S5/D36 (E-31): 82 -> 84 — PL OOM leaves with the runner (a code for a cgroup that no
  // longer exists), and PL LOAD, BUSY and CONTEXT_ENDED join the area. PL SCHEMA,
  // DESTRUCTIVE_UPGRADE and REJECTED were already named by this list and had no HTTP status,
  // which is the defect the mapping case below now holds.
  // S5 closeout: 84 -> 86 — RT NAV_TARGET_MISSING and NAV_HREF_REFUSED: `cms_nav` renders,
  // and a menu row that cannot become a link is refused by name rather than emitted as a
  // dead `href` (app/render/nav.ts).
  const total = Object.values(codes.areas).reduce((n, names) => n + names.length, 0);
  // 86 at S5 closeout (+NAV_TARGET_MISSING/HREF_REFUSED); 87 with S8o's SKW_E_SEC_FORBIDDEN
  // (a valid session whose role may not install a package); 95 with S13's eight theme-package
  // codes (a package that disagrees with itself is refused by name, before a byte is stored).
  // The count is the lock: a code that appears in neither this file nor the app's map makes one
  // of the two mirrors wrong.
  assert.equal(total, 95, `the taxonomy holds ${total} codes, expected 95 (87 + S13's 8 theme codes)`);
  for (const code of ['SKW_E_RT_PAGE_NOT_FOUND', 'SKW_E_PLT_INTERNAL', 'SKW_E_PLT_REQUEST_INVALID', 'SKW_E_PLT_BODY_TOO_LARGE']) {
    assert.equal(codes.retry_after?.[code], undefined, `${code} must not carry Retry-After`);
  }
});

test('S5: every PL refusal that can reach a response is mapped — SKW_E_PL_SCHEMA included', () => {
  // The defect this case exists for: §8.2's upgrade refusal raised `SKW_E_PL_SCHEMA`, the code
  // was absent from `HTTP`, and `AppError` therefore threw `INTERNAL: no HTTP mapping` at the
  // moment it was constructed — so a plain "this package needs a newer schema" became a 500
  // named after the error mapper. Measured in the S5 QA, reproduced here.
  const schema = new AppError('SKW_E_PL_SCHEMA', 'notes needs site.db >= 4; this tenant is 3');
  assert.equal(schema.status, 409, 'SKW_E_PL_SCHEMA must be a 409, not an unmapped INTERNAL');
  assert.equal(errorBody(schema, 'r').error.code, 'SKW_E_PL_SCHEMA');
  assert.equal(codes.http['SKW_E_PL_SCHEMA'], 409);

  // The codes this slice introduced or re-pointed, each constructible and each with a status.
  const added: [string, number][] = [
    ['SKW_E_PL_SCHEMA', 409],
    ['SKW_E_PL_DESTRUCTIVE_UPGRADE', 409],
    ['SKW_E_PL_REJECTED', 403],
    ['SKW_E_PL_BUSY', 409],
    ['SKW_E_PL_LOAD', 500],
    ['SKW_E_PL_CONTEXT_ENDED', 500],
  ];
  for (const [code, status] of added) {
    assert.equal(HTTP[code], status, `${code} is not mapped to ${status}`);
    assert.equal(codes.http[code], status, `${code} disagrees with schema/error-codes.json`);
    assert.equal(new AppError(code, 'x').status, status, `${code} cannot be constructed without throwing`);
  }

  // A PL code that does not become a response stays out of the map, and says why: these are
  // raised as plain `Error` by `ops.ts` and travel to the *plugin*, not to a browser.
  for (const code of ['SKW_E_PL_ROW', 'SKW_E_PL_QUERY', 'SKW_E_PL_NO_TABLE', 'SKW_E_PL_MAIL']) {
    assert.equal(HTTP[code], undefined, `${code} is plugin-facing and must not have an HTTP status`);
  }
});

test('S5: SKW_E_PL_OOM is withdrawn from the taxonomy with the runner (§13.3.9)', () => {
  // E-31 withdrew it: it named a per-package cgroup that no longer exists. A code left in the
  // map is a status for a mechanism nobody can reach, which reads as a control that is still
  // there. Absence is the assertion.
  assert.equal(HTTP['SKW_E_PL_OOM'], undefined, 'SKW_E_PL_OOM must be gone from the app map');
  assert.equal(codes.http['SKW_E_PL_OOM'], undefined, 'SKW_E_PL_OOM must be gone from the frozen taxonomy');
  assert.equal(codes.areas.PL?.includes('OOM'), false, 'OOM must be gone from areas.PL');
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
