#!/usr/bin/env node
/**
 * Regenerate Kysely types from one tenant's `cms_table_registry.columns_json`.
 *
 *   node app/cli/gen-kysely.ts --db <site.db> [--out <file>]
 *
 * With no `--out` the file is printed to stdout, so a `--check` is `diff` rather
 * than a flag that can drift. The generator is `app/db/kysely.ts`; this file only
 * opens the database and writes the bytes.
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';

import { generateKyselyTypes } from '../db/kysely.ts';
import { openRenderRead } from '../db/classes.ts';

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value !== undefined && !value.startsWith('--') ? value : undefined;
}

const argv = process.argv.slice(2);
const dbPath = flag(argv, 'db');
if (dbPath === undefined) {
  process.stderr.write('usage: gen-kysely --db <site.db> [--out <file>]\n');
  process.exit(2);
}
const out = flag(argv, 'out');

const db = openRenderRead(dbPath);
try {
  const text = generateKyselyTypes(db);
  if (out === undefined) process.stdout.write(text);
  else {
    writeFileSync(out, text);
    process.stdout.write(`wrote ${out} (${Buffer.byteLength(text)} bytes)\n`);
  }
} finally {
  db.close();
}
