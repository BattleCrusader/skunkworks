/**
 * schema/error-codes.json stays the authority (§4.3) even though the app keeps
 * a compile-time map: this test fails when the two disagree, so a new code or a
 * changed status cannot go unnoticed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { CODE_PATTERN, HTTP, RETRY_AFTER } from '../app/errors.ts';
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
  // E-4: 67 -> 71 codes, and none of the four carries a Retry-After.
  const total = Object.values(codes.areas).reduce((n, names) => n + names.length, 0);
  assert.equal(total, 71, `the taxonomy holds ${total} codes, expected 71 (E-4)`);
  for (const code of ['SKW_E_RT_PAGE_NOT_FOUND', 'SKW_E_PLT_INTERNAL', 'SKW_E_PLT_REQUEST_INVALID', 'SKW_E_PLT_BODY_TOO_LARGE']) {
    assert.equal(codes.retry_after?.[code], undefined, `${code} must not carry Retry-After`);
  }
});
