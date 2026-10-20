/**
 * S2e (5) — Kysely types generated from `cms_table_registry.columns_json` (C-13).
 *
 * The registry is the closed-type column inventory, so the generator reads it and
 * nothing else. Two gates:
 *
 *   - a regenerated file is byte-identical to a second regeneration from the same
 *     live schema;
 *   - every column and its mapped type agrees with `PRAGMA table_xinfo` of the
 *     live table, so "the file matches the schema" is checked against the schema,
 *     not against the generator's own opinion.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';

import { openAdminWrite } from '../app/db/classes.ts';
import { generateKyselyTypes, writeKyselyTypes } from '../app/db/kysely.ts';
import { runDdl } from '../app/ddl/run.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';

const ACTOR = { userId: 1, label: 'builder@acme.test' };

let fixture: Fixture;
let file: string;

before(() => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
  file = fixture.sitePath('acme');
  runDdl(
    file,
    [
      {
        op: 'create_table',
        name: 'u_posts',
        columns: [
          { name: 'title', type: 'TEXT', notNull: true },
          { name: 'slug', type: 'TEXT', notNull: true },
          { name: 'status', type: 'TEXT', notNull: true },
          { name: 'views', type: 'INTEGER' },
          { name: 'rating', type: 'REAL' },
          { name: 'featured', type: 'BOOLEAN', notNull: true, default: false },
          { name: 'published_at', type: 'DATE' },
        ],
      },
      { op: 'create_index', table: 'u_posts', name: 'ix_posts_slug', columns: ['slug'], unique: true },
      {
        op: 'create_table',
        name: 'u_notes',
        columns: [{ name: 'body', type: 'TEXT', notNull: true }],
      },
    ],
    { actor: ACTOR },
  );
});

after(() => {
  fixture.cleanup();
});

test('S2E-15. regenerating from the same live schema is byte-identical', () => {
  const db = openAdminWrite(file);
  try {
    const a = generateKyselyTypes(db);
    const b = generateKyselyTypes(db);
    assert.equal(a, b, 'two regenerations from one live schema differed');

    const out = `${fixture.dir}/types-a.ts`;
    const written = writeKyselyTypes(db, out);
    assert.equal(written.bytes, Buffer.byteLength(a));
    const onDisk = readFileSync(out, 'utf8');
    assert.equal(onDisk, a, 'the file on disk is not the generator output');
  } finally {
    db.close();
  }

  // A second connection to the same file is the same live schema.
  const again = openAdminWrite(file);
  try {
    assert.equal(generateKyselyTypes(again), generateKyselyTypes(again));
  } finally {
    again.close();
  }
});

test('S2E-16. every generated column and type agrees with PRAGMA table_xinfo of the live table', () => {
  const db = openAdminWrite(file);
  try {
    const text = generateKyselyTypes(db);
    const map: Record<string, string> = { TEXT: 'string', DATE: 'string', INTEGER: 'number', REAL: 'number', BOOLEAN: 'number' };
    for (const table of ['u_posts', 'u_notes']) {
      const info = db.prepare(`PRAGMA table_xinfo("${table}")`).all() as { name: string; type: string; notnull: number }[];
      for (const col of info) {
        const type = map[(col.type || 'TEXT').toUpperCase()] ?? 'string';
        // `INTEGER PRIMARY KEY` is the rowid: it cannot be NULL even though
        // `table_xinfo.notnull` is 0 for it (SQLite only reports the declared
        // constraint). The generator treats `id` as non-null and so does this check.
        const notNull = col.name === 'id' || col.notnull === 1;
        const expected = notNull ? `${col.name}: ${type};` : `${col.name}: ${type} | null;`;
        assert.ok(text.includes(expected), `${table}.${col.name}: expected "${expected}" in:\n${text}`);
      }
    }
    // And the registry is what was read: a table absent from it is absent from the file.
    db.prepare("UPDATE cms_table_registry SET table_name = 'u_notes_renamed' WHERE table_name = 'u_notes'").run();
    assert.ok(!generateKyselyTypes(db).includes('u_notes:'), 'a table deleted from the registry stayed in the types');
  } finally {
    db.close();
  }
});

test('S2E-17. the committed base-schema types regenerate identically from a fresh site.db', () => {
  const fresh = `${fixture.dir}/fresh.db`;
  const seed = new Database(fresh);
  seed.exec(readFileSync(new URL('../schema/site.sql', import.meta.url), 'utf8'));
  seed.close();
  const db = openAdminWrite(fresh);
  try {
    const generated = generateKyselyTypes(db);
    const committed = readFileSync(new URL('../app/db/kysely.generated.ts', import.meta.url), 'utf8');
    assert.equal(generated, committed, 'app/db/kysely.generated.ts is stale — regenerate it with app/cli/gen-kysely.ts');
  } finally {
    db.close();
  }
});
