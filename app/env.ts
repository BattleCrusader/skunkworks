/**
 * Environment: one prefix, `SKW_` (SDS §4.3 / register §4.2).
 *
 * Boot order steps 1 and 2 of SDS §2.3 live here:
 *   1. refuse any key matching ^SK_|^SKUNK_, naming the key and its replacement
 *   2. assert SKW_ARGON2_MAX_CONCURRENT=4 and UV_THREADPOOL_SIZE=8
 */
import { DELETED_ENV_NAMES } from './env-deleted.ts';

/** A refusal raised before the process is allowed to serve. */
export class BootRefusal extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'BootRefusal';
    this.exitCode = exitCode;
  }
}

export interface Env {
  dataDir: string;
  dbPoolMax: number;
  dbBusyTimeoutMs: number;
  edgeToken: string;
  edgeTrustedCidrs: string[];
  sessionKey: string;
  downloadTokenKey: string;
  ipHashKey: string;
  adminOrigin: string;
  argon2MaxConcurrent: number;
  ddlMaxStatements: number;
  renderMode: 'live' | 'snapshot';
  exportNow: string | undefined;
  schemaEdit: 'on' | 'off';
  fleetMode: boolean;
  buildId: string;
  smtpUrl: string | undefined;
  snapshotMaxCombos: number;
  snapshotMaxBytes: number;
  repointMaxRows: number;
  boxRps: number;
  emailMode: 'off' | 'smtp';
  port: number;
}

/** §4.2: twenty-two names, and this table is the complete list. */
export const SKW_NAMES = [
  'SKW_DATA_DIR', 'SKW_DB_POOL_MAX', 'SKW_DB_BUSY_TIMEOUT_MS', 'SKW_EDGE_TOKEN',
  'SKW_EDGE_TRUSTED_CIDRS', 'SKW_SESSION_KEY', 'SKW_DOWNLOAD_TOKEN_KEY', 'SKW_IP_HASH_KEY',
  'SKW_ADMIN_ORIGIN', 'SKW_ARGON2_MAX_CONCURRENT', 'SKW_DDL_MAX_STATEMENTS', 'SKW_RENDER_MODE',
  'SKW_EXPORT_NOW', 'SKW_SCHEMA_EDIT', 'SKW_FLEET_MODE', 'SKW_BUILD_ID', 'SKW_SMTP_URL',
  'SKW_SNAPSHOT_MAX_COMBOS', 'SKW_SNAPSHOT_MAX_BYTES', 'SKW_REPOINT_MAX_ROWS', 'SKW_BOX_RPS',
  'SKW_EMAIL_MODE',
] as const;

/** §2.3 step 1: refuse to start without these six. */
export const REQUIRED_FOR_APP = [
  'SKW_EDGE_TOKEN', 'SKW_SESSION_KEY', 'SKW_DOWNLOAD_TOKEN_KEY', 'SKW_IP_HASH_KEY',
  'SKW_ADMIN_ORIGIN', 'SKW_BUILD_ID',
] as const;

const DELETED_PREFIX = /^SK_|^SKUNK_/;

/**
 * Refuse any environment key matching ^SK_|^SKUNK_, printing the offending key
 * and its replacement. Returns the list of offenders (empty when clean) so the
 * gate can assert on the message without parsing stderr only.
 */
export function assertNoDeletedPrefixes(source: NodeJS.ProcessEnv): string[] {
  const offenders: string[] = [];
  for (const key of Object.keys(source)) {
    if (DELETED_PREFIX.test(key)) offenders.push(key);
  }
  if (offenders.length === 0) return [];
  offenders.sort();
  const lines = offenders.map((key) => {
    const replacement = DELETED_ENV_NAMES[key];
    return replacement
      ? `${key} -> ${replacement}`
      : `${key} -> no replacement (deleted; see SDS \u00a74.3)`;
  });
  throw new BootRefusal(
    `refusing to start: deleted environment prefix in use (^SK_|^SKUNK_)\n${lines.join('\n')}`,
  );
}

function int(source: NodeJS.ProcessEnv, name: string, dflt: number): number {
  const raw = source[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new BootRefusal(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function str(source: NodeJS.ProcessEnv, name: string, dflt: string): string {
  const raw = source[name];
  return raw === undefined || raw === '' ? dflt : raw;
}

function required(source: NodeJS.ProcessEnv, name: string): string {
  const raw = source[name];
  if (raw === undefined || raw === '') {
    throw new BootRefusal(`refusing to start: ${name} is required (SDS \u00a72.3 step 1)`);
  }
  return raw;
}

/**
 * Parse + validate the environment.
 *
 * `role: 'migrate'` skips the app-only assertions (§2.3 step 2) and the six
 * required keys: `migrate` needs SKW_DATA_DIR and nothing else.
 */
export function loadEnv(
  source: NodeJS.ProcessEnv = process.env,
  opts: { role?: 'app' | 'migrate' } = {},
): Env {
  const role = opts.role ?? 'app';
  assertNoDeletedPrefixes(source);

  const dataDir = str(source, 'SKW_DATA_DIR', '/srv/data');
  const adminOrigin = role === 'app' ? required(source, 'SKW_ADMIN_ORIGIN') : str(source, 'SKW_ADMIN_ORIGIN', '');
  if (adminOrigin !== '' && !/^https?:\/\/[^/]+$/i.test(adminOrigin)) {
    throw new BootRefusal(`SKW_ADMIN_ORIGIN must be an exact origin (scheme://host[:port]), got ${JSON.stringify(adminOrigin)}`);
  }

  const env: Env = {
    dataDir,
    dbPoolMax: int(source, 'SKW_DB_POOL_MAX', 64),
    dbBusyTimeoutMs: int(source, 'SKW_DB_BUSY_TIMEOUT_MS', 5000),
    edgeToken: role === 'app' ? required(source, 'SKW_EDGE_TOKEN') : str(source, 'SKW_EDGE_TOKEN', ''),
    edgeTrustedCidrs: splitCidrs(str(source, 'SKW_EDGE_TRUSTED_CIDRS', '127.0.0.1/32,172.16.0.0/12')),
    sessionKey: role === 'app' ? required(source, 'SKW_SESSION_KEY') : str(source, 'SKW_SESSION_KEY', ''),
    downloadTokenKey: role === 'app' ? required(source, 'SKW_DOWNLOAD_TOKEN_KEY') : str(source, 'SKW_DOWNLOAD_TOKEN_KEY', ''),
    ipHashKey: role === 'app' ? required(source, 'SKW_IP_HASH_KEY') : str(source, 'SKW_IP_HASH_KEY', ''),
    adminOrigin,
    argon2MaxConcurrent: int(source, 'SKW_ARGON2_MAX_CONCURRENT', 4),
    ddlMaxStatements: int(source, 'SKW_DDL_MAX_STATEMENTS', 8),
    renderMode: parseEnum(source, 'SKW_RENDER_MODE', 'live', ['live', 'snapshot'] as const),
    exportNow: str(source, 'SKW_EXPORT_NOW', '') === '' ? undefined : str(source, 'SKW_EXPORT_NOW', ''),
    schemaEdit: parseEnum(source, 'SKW_SCHEMA_EDIT', 'off', ['on', 'off'] as const),
    fleetMode: str(source, 'SKW_FLEET_MODE', '1') !== '0',
    buildId: role === 'app' ? required(source, 'SKW_BUILD_ID') : str(source, 'SKW_BUILD_ID', 'dev'),
    smtpUrl: str(source, 'SKW_SMTP_URL', '') === '' ? undefined : str(source, 'SKW_SMTP_URL', ''),
    snapshotMaxCombos: int(source, 'SKW_SNAPSHOT_MAX_COMBOS', 1024),
    snapshotMaxBytes: int(source, 'SKW_SNAPSHOT_MAX_BYTES', 2097152),
    repointMaxRows: int(source, 'SKW_REPOINT_MAX_ROWS', 5000),
    boxRps: int(source, 'SKW_BOX_RPS', 192),
    emailMode: parseEnum(source, 'SKW_EMAIL_MODE', 'off', ['off', 'smtp'] as const),
    port: int(source, 'PORT', 3000),
  };

  if (role === 'app') {
    // §2.3 step 2. C-6: 8 x 64 MiB peaks at 687 MB inside a 1 GB container;
    // 4 x 19 MiB is 76 MiB. UV_THREADPOOL_SIZE must be 8 in the image.
    if (env.argon2MaxConcurrent !== 4) {
      throw new BootRefusal(`SKW_ARGON2_MAX_CONCURRENT must be 4 (SDS \u00a72.3 step 2, C-6); got ${env.argon2MaxConcurrent}`);
    }
    const pool = source.UV_THREADPOOL_SIZE;
    if (pool !== '8') {
      throw new BootRefusal(`UV_THREADPOOL_SIZE must be 8 (SDS \u00a72.3 step 2); got ${pool ?? '(unset)'}`);
    }
    if (env.renderMode === 'snapshot' && env.exportNow === undefined) {
      throw new BootRefusal('SKW_EXPORT_NOW is required when SKW_RENDER_MODE=snapshot (SDS \u00a74.3)');
    }
    if (env.emailMode === 'smtp' && env.smtpUrl === undefined) {
      throw new BootRefusal('SKW_SMTP_URL is required when SKW_EMAIL_MODE=smtp (SDS \u00a74.3)');
    }
  }

  return env;
}

function parseEnum<T extends readonly string[]>(source: NodeJS.ProcessEnv, name: string, dflt: T[number], allowed: T): T[number] {
  const raw = str(source, name, dflt);
  if (!allowed.includes(raw)) {
    throw new BootRefusal(`${name} must be one of ${allowed.join('|')}, got ${JSON.stringify(raw)}`);
  }
  return raw as T[number];
}

function splitCidrs(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

/** The admin listener is the admin host of SKW_ADMIN_ORIGIN (§9.1). */
export function adminHostOf(adminOrigin: string): string | null {
  if (adminOrigin === '') return null;
  try {
    return new URL(adminOrigin).host.toLowerCase();
  } catch {
    return null;
  }
}
