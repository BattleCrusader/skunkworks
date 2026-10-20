/**
 * A real control.db + real site.db files under a temp SKW_DATA_DIR.
 * Nothing is mocked: every gate below reads the same DDL the image ships.
 */
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SCHEMA = join(REPO, 'schema');

export type Mode = 'production' | 'demo' | 'internal';
export type Status = 'provisioning' | 'active' | 'suspended' | 'archived';

export interface TenantSpec {
  key: string;
  hosts: string[];
  mode?: Mode;
  status?: Status;
  displayName?: string;
  title?: string;
  body?: string;
  /** Write a non-database file at tenants/<key>/site.db (the corrupt fixture). */
  corrupt?: boolean;
}

export interface Fixture {
  dir: string;
  controlDb: string;
  env: Record<string, string>;
  specs: TenantSpec[];
  sitePath(key: string): string;
  cleanup(): void;
}

export const EDGE_TOKEN = 'test-edge-token-0123456789abcdef';
export const ADMIN_ORIGIN = 'https://admin.skw.test';

export const DEFAULT_SPECS: TenantSpec[] = [
  {
    key: 'acme',
    hosts: ['acme.test', 'www.acme.test'],
    displayName: 'Acme',
    title: 'Acme pricing',
    body: '<h1>Acme pricing</h1><p>Acme pays less.</p>',
  },
  {
    key: 'beta',
    hosts: ['beta.test'],
    displayName: 'Beta',
    title: 'Beta pricing',
    body: '<h1>Beta pricing</h1><p>Beta pays more.</p>',
  },
  {
    key: 'demo-acme',
    // NOT demos.skw.test: that name is the demos vhost (§5.6), and a domain row
    // for it would emit a second server block with the same server_name.
    hosts: ['acme-demo.test'],
    mode: 'demo',
    displayName: 'Acme (demo)',
    title: 'Acme demo pricing',
    body: '<h1>Acme demo pricing</h1>',
  },
  {
    key: 'broken',
    hosts: ['broken.test'],
    displayName: 'Broken',
    corrupt: true,
  },
];

export interface FixtureOptions {
  specs?: TenantSpec[];
  /** false leaves site.db absent so `migrate` has to create it. */
  createSiteDbs?: boolean;
  /** false writes garbage over control.db (the control-plane gate). */
  controlOk?: boolean;
}

export function makeFixture(opts: FixtureOptions = {}): Fixture {
  const specs = opts.specs ?? DEFAULT_SPECS;
  const createSiteDbs = opts.createSiteDbs ?? true;
  const dir = mkdtempSync(join(tmpdir(), 'skw-s1-'));
  const controlDb = join(dir, 'control.db');
  const sitePath = (key: string): string => join(dir, 'tenants', key, 'site.db');

  const control = new Database(controlDb);
  control.pragma('journal_mode = WAL');
  control.exec(readFileSync(join(SCHEMA, 'control.sql'), 'utf8'));
  if (opts.controlOk === false) {
    control.close();
    writeFileSync(controlDb, 'this is not a database\n');
    rmSync(`${controlDb}-wal`, { force: true });
    rmSync(`${controlDb}-shm`, { force: true });
  } else {
    const insertTenant = control.prepare(
      `INSERT INTO tenant (key, mode, status, display_name, db_version, demo_expires_at)
       VALUES (?, ?, ?, ?, 3, ?)`,
    );
    const insertDomain = control.prepare(
      'INSERT INTO domain (host, tenant_id, kind, is_primary) VALUES (?, ?, ?, ?)',
    );
    for (const spec of specs) {
      const info = insertTenant.run(
        spec.key,
        spec.mode ?? 'production',
        spec.status ?? 'active',
        spec.displayName ?? spec.key,
        (spec.mode ?? 'production') === 'demo' ? '2030-01-01T00:00:00.000Z' : null,
      );
      const tenantId = Number(info.lastInsertRowid);
      spec.hosts.forEach((host, i) => {
        insertDomain.run(host, tenantId, i === 0 ? 'primary' : 'alias', i === 0 ? 1 : 0);
      });
    }
    control.close();
  }

  for (const spec of specs) {
    const file = sitePath(spec.key);
    mkdirSync(dirname(file), { recursive: true });
    if (spec.corrupt === true) {
      writeFileSync(file, 'this is not a database\n');
      continue;
    }
    if (!createSiteDbs) continue;
    const site = new Database(file);
    site.pragma('journal_mode = WAL');
    site.exec(readFileSync(join(SCHEMA, 'site.sql'), 'utf8'));
    site
      .prepare(
        `INSERT INTO cms_page (path, slug, title, status, template, body_html, published_at)
         VALUES ('/pricing', 'pricing', ?, 'published', 'page', ?, '2026-01-01T00:00:00.000Z')`,
      )
      .run(spec.title ?? `${spec.key} pricing`, spec.body ?? `<h1>${spec.key} pricing</h1>`);
    site.close();
  }

  return {
    dir,
    controlDb,
    specs,
    sitePath,
    env: {
      SKW_DATA_DIR: dir,
      SKW_EDGE_TOKEN: EDGE_TOKEN,
      SKW_SESSION_KEY: 'test-session-key-0123456789abcdef',
      SKW_DOWNLOAD_TOKEN_KEY: 'test-download-key-0123456789abcdef',
      SKW_IP_HASH_KEY: 'test-ip-hash-key-0123456789abcdef',
      SKW_ADMIN_ORIGIN: ADMIN_ORIGIN,
      SKW_BUILD_ID: 'test-build',
      SKW_ARGON2_MAX_CONCURRENT: '4',
      SKW_BOX_RPS: '192',
      UV_THREADPOOL_SIZE: '8',
    },
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
