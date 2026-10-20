/**
 * One OS process, one `consumeUse`, fired at an agreed instant.
 *
 * This exists because a single Node process cannot race itself: `better-sqlite3` is
 * synchronous and the event loop runs one callback at a time, so 8 parallel HTTP
 * requests in `download-redeem.test.ts` prove the *route's* accounting but not the
 * *transaction's* ordering. This child is the other half — 8 processes, 8 connections,
 * one `BEGIN IMMEDIATE` each, released at the same millisecond.
 *
 * Usage: node consume-child.ts <db> <jti> <codeId> <assetId> <bytes> <startEpochMs>
 * Prints one JSON line: {"spent":boolean,"continuation":boolean,"reason":string|null}
 */
import Database from 'better-sqlite3';

import { consumeUse } from '../../app/download/ledger.ts';

const [dbPath, jti, codeId, assetId, bytes, startMs] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
  string,
];

const db = new Database(dbPath);
db.pragma('busy_timeout = 15000');
db.pragma('foreign_keys = 1');

const wait = Number(startMs) - Date.now();
setTimeout(
  () => {
    try {
      const result = consumeUse(db, {
        jti,
        codeId: Number(codeId),
        assetId: Number(assetId),
        bytesDeclared: Number(bytes),
        ipHash: 'ip'.repeat(11),
        uaHash: 'ua'.repeat(11),
        at: new Date().toISOString(),
        nowMs: Date.now(),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (err) {
      process.stdout.write(`${JSON.stringify({ error: String(err) })}\n`);
    } finally {
      db.close();
    }
  },
  Math.max(0, wait),
);
