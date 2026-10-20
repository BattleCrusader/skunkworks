#!/usr/bin/env node
/**
 * `control.db` from the shell — `apply`, `scalar`, `tenants`, `version` (SDS §11.6, E-19).
 *
 * `install.sh` needs four things from SQLite: apply `schema/control.sql`, read
 * `PRAGMA user_version`, count rows, and list the tenants it just seeded. Before this
 * file it shelled out to the `sqlite3` **binary**, which is not on a minimal server image
 * and is a second SQLite (a different build, a different `PRAGMA` default) from the one
 * the product ships. This uses `node:sqlite`, the SQLite inside the Node the bundle
 * already requires, so the installer's dependency list is `node` and nothing else.
 *
 * `apply` creates the file with `O_EXCL` and refuses an existing database: an install
 * that re-applied DDL over a live `control.db` would be a migration nobody wrote. The
 * shell removes the file (or uses `--force`) before calling.
 *
 * Exit: 0 ok, 1 refused, 2 usage, 12 the database could not be opened/applied.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';

const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;
const EXIT_DB = 12;

function refuse(message, code = EXIT_REFUSED) {
  process.stderr.write(`control_db: REFUSAL: ${message}\n`);
  process.exit(code);
}

const argv = process.argv.slice(2);
const op = argv[0];
const value = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

const dbPath = value('db');
if (dbPath === undefined) refuse('--db is required', EXIT_USAGE);

if (op === 'version' || op === 'scalar' || op === 'tenants') {
  if (!existsSync(dbPath)) refuse(`${dbPath} does not exist`, EXIT_DB);
}

// `apply` creates the file with `O_EXCL`: DDL over a live control.db is a migration nobody
// wrote. The check has to happen **before** the handle opens, because opening creates it.
if (op === 'apply' && existsSync(dbPath)) {
  refuse(`${dbPath} already exists; apply is for a fresh database`);
}

let db;
try {
  db = new DatabaseSync(dbPath);
} catch (err) {
  refuse(`cannot open ${dbPath}: ${String(err)}`, EXIT_DB);
}

try {
  switch (op) {
    case 'apply': {
      const file = value('file');
      if (file === undefined) refuse('apply needs --file <schema.sql>', EXIT_USAGE);
      const ddl = readFileSync(file, 'utf8');
      // One transaction: a half-applied schema is a database the app will migrate
      // forever. `exec` runs the whole file; SQLite's own DDL is transactional.
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(ddl);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        refuse(`${file} did not apply: ${String(err)}`, EXIT_DB);
      }
      const { user_version: version } = db.prepare('PRAGMA user_version').get();
      process.stdout.write(`v${String(version)}\n`);
      break;
    }
    case 'version': {
      const { user_version: version } = db.prepare('PRAGMA user_version').get();
      process.stdout.write(`${String(version)}\n`);
      break;
    }
    case 'scalar': {
      const sql = value('sql');
      if (sql === undefined) refuse('scalar needs --sql <sql>', EXIT_USAGE);
      const row = db.prepare(sql).get();
      const first = row === undefined ? undefined : Object.values(row)[0];
      process.stdout.write(`${first === undefined || first === null ? '' : String(first)}\n`);
      break;
    }
    case 'tenants': {
      // `key<TAB>mode<TAB>status`, one line per tenant, in key order. The shell reads it
      // to install each tenant's own `site.db` where the app looks for it (§12.2).
      const rows = db.prepare('SELECT key, mode, status FROM tenant ORDER BY key').all();
      for (const row of rows) process.stdout.write(`${row.key}\t${row.mode}\t${row.status}\n`);
      break;
    }
    default:
      refuse(`unknown operation ${JSON.stringify(op ?? 'none')} (apply|version|scalar|tenants)`, EXIT_USAGE);
  }
} catch (err) {
  refuse(String(err), EXIT_DB);
} finally {
  db.close();
}
