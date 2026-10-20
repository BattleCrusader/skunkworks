#!/usr/bin/env node
/**
 * `skwctl` — the two things that cannot be done through the admin surface:
 * creating the first operator on a fresh box, and replacing a factor when nobody
 * can log in (E-19, SDS §11.6a).
 *
 *   skwctl admin bootstrap        [--generate-password | --password-stdin]
 *                                 [--email <email>] [--tenant <key>]
 *                                 [--enrolment-out <path>]
 *   skwctl admin reset-totp       --email <email> --enrolment-out <path>
 *   skwctl admin reset-password   --email <email> (--password-stdin | --generate-password)
 *                                 [--enrolment-out <path>]
 *   skwctl plugin install <dir>   --tenant <key> [--test-report <path>]
 *                                 [--runner-digest <sha256:…>] [--enable]
 *   skwctl plugin enable <id>     --tenant <key>
 *   skwctl plugin disable <id>    --tenant <key>
 *   skwctl plugin list            --tenant <key>
 *
 * The plugin verbs are the operator surface S4d's report named as missing: installing a
 * package was a library call with no admin route and no CLI, so a plugin could not be put
 * on a running box at all. They are root-side (they write `<data>/plugins`, which the app
 * mounts read-only) and audit every change with `actor_label = 'skwctl'`.
 *
 * Three rules the errata fixes and this file does not soften:
 *
 * 1. **The secret goes to `--enrolment-out` and nowhere else.** One file, created
 *    `0600` with `O_EXCL` so it will not overwrite an earlier enrolment. Stdout
 *    carries the path and the login URL only. A non-terminal stdout is refused
 *    (`SECRET_NOT_PRINTABLE`) unless `--enrolment-out` is given, because
 *    `install.sh` logs its own output and a TOTP secret in an install log is a
 *    secret in a support bundle. `--enrolment-out -` is refused for the same
 *    reason. No secret reaches `audit_log`, `BUNDLE.json`, `control.seed.json` or
 *    a log line.
 * 2. **Exit 3 is the only benign refusal** (`ALREADY_BOOTSTRAPPED`), so `install.sh`
 *    can tell "this box is already set up" from "this install failed". Every other
 *    refusal exits 1 with `REFUSAL: <REASON>` on stderr. A second run therefore
 *    changes no user row.
 * 3. **Nothing is claimed that is not a claim marker.** The seeded row is
 *    `must_change=1`, `totp_secret IS NULL`, `last_login_at IS NULL`. A row that
 *    fails any of the three is somebody's credential, and this command writes
 *    nothing and says which command would change it.
 *
 * There are no recovery codes: recovery is `reset-totp` over shell access on the
 * box, and that is not an escalation — whoever can run it can read
 * `SKW_SESSION_KEY` out of `.env` and mint a session directly.
 */
import Database from 'better-sqlite3';
import { hash } from '@node-rs/argon2';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARGON2_OPTIONS, Semaphore } from '../admin/auth.ts';
import { appendAudit, verifyChain, verifyAgainstSeal } from '../audit/chain.ts';
import { AppError } from '../errors.ts';
import { installPlugin, inspectPackage, installedPlugins, uninstallPlugin } from '../plugins/install.ts';
import { importPublisherKey, readTrustStore, type InstallScreen } from '../plugins/trust.ts';
import { healGaps, lastEndedDay, sealDay, sealStatus } from '../audit/scheduler.ts';
import { SESSION_ABSOLUTE_MS } from '../admin/session.ts';
import { TOTP_PARAMETERS, groupOf, newPassword, newSecret, otpauthUri } from '../admin/totp.ts';
import { openAdminWrite } from '../db/classes.ts';
import { findProjectRoot, targetVersion } from '../db/migrate.ts';
import { loadEnv, type Env } from '../env.ts';

/** Exit 3, and only 3, is a benign refusal: the box is already set up. */
export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_ALREADY_BOOTSTRAPPED = 3;

export const PASSWORD_MIN_LENGTH = 16;

type Reason =
  | 'ALREADY_BOOTSTRAPPED'
  | 'NO_CLAIM_TARGET'
  | 'AMBIGUOUS_TARGET'
  | 'TENANT_UNKNOWN'
  | 'FLEET_ADMIN_DISABLED'
  | 'SNAPSHOT_MODE'
  | 'SCHEMA_VERSION_UNKNOWN'
  | 'SECRET_NOT_PRINTABLE'
  | 'PASSWORD_TOO_SHORT'
  | 'ADMIN_ORIGIN_UNSET'
  | 'ENROLMENT_EXISTS'
  | 'PLUGIN_REFUSED'
  | 'PLUGIN_UNKNOWN'
  | 'AUDIT_SEAL_MISMATCH'
  | 'AUDIT_SEAL_UNSEALED'
  | 'AUDIT_SEAL_EMPTY'
  | 'AUDIT_SEAL_CHAIN'
  | 'AUDIT_SEAL_FAILED'
  | 'USAGE';

export class Refusal extends Error {
  readonly reason: Reason;
  readonly exitCode: number;
  constructor(reason: Reason, message: string, exitCode = EXIT_REFUSED) {
    super(`${reason}: ${message}`);
    this.name = 'Refusal';
    this.reason = reason;
    this.exitCode = exitCode;
  }
}

interface Args {
  command: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: readonly string[]): Args {
  const command: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      command.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next);
      i += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { command, flags };
}

interface UserRow {
  id: number;
  tenant_id: number | null;
  email: string;
  role: string;
  totp_secret: string | null;
  must_change: number;
  last_login_at: string | null;
}

interface TenantRow {
  id: number;
  key: string;
  mode: string;
  status: string;
}

/** Claimable = the seed's marker and nothing else. */
export function isClaimable(row: UserRow): boolean {
  return row.totp_secret === null && row.must_change === 1 && row.last_login_at === null;
}

export interface CliContext {
  env: Env;
  controlPath: string;
  schemaDir: string;
  semaphore: Semaphore;
  /** Injected so a gate can assert without a TTY. */
  isTty: boolean;
  stdin: () => Promise<string>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export function makeContext(): CliContext {
  const env = loadEnv(process.env, { role: 'migrate' });
  const schemaDir = join(findProjectRoot(), 'schema');
  return {
    env,
    controlPath: join(env.dataDir, 'control.db'),
    schemaDir,
    semaphore: new Semaphore(env.argon2MaxConcurrent),
    isTty: process.stdout.isTTY === true,
    stdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    },
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
}

/** The enrolment file: 0600, `O_EXCL`, and the only artefact that carries a secret. */
export function writeEnrolmentFile(path: string, lines: readonly string[]): void {
  if (path === '-') {
    throw new Refusal(
      'SECRET_NOT_PRINTABLE',
      '--enrolment-out - is refused: a secret on stdout is a secret in an install log',
    );
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as { code?: string }).code === 'EEXIST') {
      throw new Refusal('ENROLMENT_EXISTS', `${path} already exists; it will not overwrite an earlier enrolment`);
    }
    throw err;
  }
}

function enrolmentLines(input: {
  adminUrl: string;
  email: string;
  password: string | undefined;
  secret: string;
  action: string;
}): string[] {
  const lines = [
    'Skunkworks — one-time enrolment',
    `action:   ${input.action}`,
    `admin:    ${input.adminUrl}`,
    `email:    ${input.email}`,
  ];
  if (input.password !== undefined) lines.push(`password: ${input.password}`);
  lines.push(
    `secret:   ${groupOf(input.secret)}`,
    `params:   ${TOTP_PARAMETERS}`,
    `uri:      ${otpauthUri(input.email, input.secret)}`,
    '',
    'Add the URI (or the secret) to an authenticator app, sign in, and confirm the',
    'code. Then delete this file: with a generated password it is the only copy of it.',
    'A lost authenticator is recovered with: skwctl admin reset-totp --email <email> --enrolment-out <path>',
  );
  return lines;
}

function requireSchemaVersion(db: Database.Database, ctx: CliContext): void {
  const version = Number(db.pragma('user_version', { simple: true }));
  const expected = targetVersion(join(ctx.schemaDir, 'control.sql'));
  if (version !== expected) {
    throw new Refusal(
      'SCHEMA_VERSION_UNKNOWN',
      `control.db is at user_version ${version}, this image expects ${expected}; run the installer's migrate step first`,
    );
  }
}

function selectTarget(db: Database.Database, ctx: CliContext, flags: Args['flags']): UserRow {
  const email = typeof flags.get('email') === 'string' ? (flags.get('email') as string) : undefined;
  const tenantKey = typeof flags.get('tenant') === 'string' ? (flags.get('tenant') as string) : undefined;

  const all = db
    .prepare(
      'SELECT id, tenant_id, email, role, totp_secret, must_change, last_login_at FROM user_account ORDER BY id',
    )
    .all() as UserRow[];

  if (email !== undefined) {
    const row = all.find((r) => r.email.toLowerCase() === email.toLowerCase());
    if (row === undefined) throw new Refusal('NO_CLAIM_TARGET', `no user_account row for ${email}`);
    if (row.role === 'fleet_admin') {
      throw new Refusal('FLEET_ADMIN_DISABLED', 'this command never creates or claims a fleet_admin');
    }
    return row;
  }

  if (tenantKey !== undefined) {
    const tenant = db.prepare('SELECT id, key, mode, status FROM tenant WHERE key = ?').get(tenantKey) as
      | TenantRow
      | undefined;
    if (tenant === undefined) throw new Refusal('TENANT_UNKNOWN', `no tenant ${tenantKey}`);
    const rows = all.filter((r) => r.tenant_id === tenant.id && r.role !== 'fleet_admin');
    if (rows.length === 0) return { id: 0, tenant_id: tenant.id, email: '', role: 'owner', totp_secret: null, must_change: 1, last_login_at: null };
    if (rows.length > 1) {
      throw new Refusal('AMBIGUOUS_TARGET', `${tenantKey} has ${rows.length} operators; pass --email`);
    }
    return rows[0] as UserRow;
  }

  if (all.length === 0) {
    const tenants = db
      .prepare("SELECT id, key, mode, status FROM tenant WHERE mode = 'production' AND status = 'active' ORDER BY id")
      .all() as TenantRow[];
    if (tenants.length === 0) throw new Refusal('NO_CLAIM_TARGET', 'no production tenant to create an owner for');
    if (tenants.length > 1) {
      throw new Refusal('AMBIGUOUS_TARGET', `${tenants.length} production tenants; pass --tenant <key>`);
    }
    const tenant = tenants[0] as TenantRow;
    return { id: 0, tenant_id: tenant.id, email: '', role: 'owner', totp_secret: null, must_change: 1, last_login_at: null };
  }

  const claimable = all.filter((r) => r.role !== 'fleet_admin' && isClaimable(r));
  if (claimable.length === 0) {
    throw new Refusal(
      'ALREADY_BOOTSTRAPPED',
      'every operator row is claimed; nothing was written. To change a factor:\n' +
        '  skwctl admin reset-totp     --email <email> --enrolment-out <path>\n' +
        '  skwctl admin reset-password --email <email> (--password-stdin | --generate-password)',
      EXIT_ALREADY_BOOTSTRAPPED,
    );
  }
  if (claimable.length > 1) {
    throw new Refusal('AMBIGUOUS_TARGET', `${claimable.length} claimable operators; pass --email or --tenant`);
  }
  return claimable[0] as UserRow;
}

async function readPassword(ctx: CliContext, flags: Args['flags'], action: string): Promise<{ password: string; generated: boolean }> {
  if (flags.has('password-stdin')) {
    const raw = (await ctx.stdin()).split('\n')[0] ?? '';
    if ([...raw].length < PASSWORD_MIN_LENGTH) {
      throw new Refusal('PASSWORD_TOO_SHORT', `a password is at least ${PASSWORD_MIN_LENGTH} characters`);
    }
    return { password: raw, generated: false };
  }
  // --generate-password, or no flag at all for bootstrap: the command's job is to
  // produce a credential a human can hold, and a generated one is the only kind
  // that never existed anywhere else.
  void action;
  return { password: newPassword(), generated: true };
}

function adminUrl(ctx: CliContext): string {
  if (ctx.env.adminOrigin === '') {
    throw new Refusal('ADMIN_ORIGIN_UNSET', 'SKW_ADMIN_ORIGIN is not set, so there is no admin URL to print');
  }
  return `${ctx.env.adminOrigin.replace(/\/$/, '')}/admin/login`;
}

/** `skwctl admin bootstrap`. */
export async function bootstrap(ctx: CliContext, flags: Args['flags']): Promise<number> {
  if (ctx.env.renderMode === 'snapshot') {
    throw new Refusal('SNAPSHOT_MODE', 'SKW_RENDER_MODE=snapshot must not write control.db');
  }
  if (!existsSync(ctx.controlPath)) {
    throw new Refusal('NO_CLAIM_TARGET', `${ctx.controlPath} does not exist; the installer seeds it before this step`);
  }
  const out = typeof flags.get('enrolment-out') === 'string' ? (flags.get('enrolment-out') as string) : undefined;
  if (out === undefined && !ctx.isTty) {
    throw new Refusal(
      'SECRET_NOT_PRINTABLE',
      'stdout is not a terminal, so the secret has nowhere to go: pass --enrolment-out <path>',
    );
  }
  if (out === undefined) {
    // A terminal is the one place a secret may be shown, and this command still
    // refuses to be the thing that decides to show it: `install.sh` logs.
    throw new Refusal('SECRET_NOT_PRINTABLE', 'pass --enrolment-out <path>; this command does not print secrets');
  }

  const url = adminUrl(ctx);
  const { password, generated } = await readPassword(ctx, flags, 'bootstrap');
  const secret = newSecret();
  const passwordHash = await ctx.semaphore.run(() => hash(password, ARGON2_OPTIONS));

  const db = openAdminWrite(ctx.controlPath, ctx.env.dbBusyTimeoutMs);
  let email = '';
  let userId = 0;
  try {
    requireSchemaVersion(db, ctx);
    const target = selectTarget(db, ctx, flags);
    const now = new Date().toISOString();
    // The seed usually names the operator already. When it does not, the created
    // row needs an address that passes `user_account.email`'s CHECK and that an
    // operator will recognise as a placeholder.
    email = target.email === '' ? 'owner@localhost.invalid' : target.email;

    const tx = db.transaction(() => {
      if (target.id === 0) {
        const info = db
          .prepare(
            `INSERT INTO user_account (tenant_id, email, password_hash, role, totp_secret, must_change)
             VALUES (?, ?, ?, 'owner', ?, 0)`,
          )
          .run(target.tenant_id, email, passwordHash, secret);
        userId = Number(info.lastInsertRowid);
      } else {
        // The claim: one statement, so a concurrent second run cannot slip between
        // the read above and the write below without failing the WHERE.
        const changed = db
          .prepare(
            `UPDATE user_account
                SET password_hash = ?, totp_secret = ?, must_change = 0,
                    failed_logins = 0, locked_until = NULL
              WHERE id = ? AND totp_secret IS NULL AND must_change = 1 AND last_login_at IS NULL`,
          )
          .run(passwordHash, secret, target.id);
        if (changed.changes !== 1) {
          throw new Refusal(
            'ALREADY_BOOTSTRAPPED',
            'the row was claimed between the read and the write; nothing was written',
            EXIT_ALREADY_BOOTSTRAPPED,
          );
        }
        userId = target.id;
      }
      // Every live session of that user dies: the credential just changed.
      db.prepare('UPDATE session SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId);
      db.prepare(
        `INSERT INTO audit_log (tenant_id, actor_user_id, actor_label, action, target_kind, target_id, after_json)
         VALUES (?, ?, 'install', 'admin.bootstrap', 'user_account', ?, ?)`,
      ).run(
        target.tenant_id,
        userId,
        String(userId),
        JSON.stringify({ generated_password: generated, totp: 'set', must_change: 0 }),
      );
      return true;
    });
    tx();
  } finally {
    db.close();
  }

  writeEnrolmentFile(
    out,
    enrolmentLines({ adminUrl: url, email, password: generated ? password : undefined, secret, action: 'admin bootstrap' }),
  );
  ctx.stdout(`enrolment written: ${out} (0600, mode O_EXCL)`);
  ctx.stdout(`login: ${url}`);
  ctx.stdout(`email: ${email}`);
  return EXIT_OK;
}

/** `skwctl admin reset-totp --email <email> --enrolment-out <path>`. */
export async function resetTotp(ctx: CliContext, flags: Args['flags']): Promise<number> {
  if (ctx.env.renderMode === 'snapshot') {
    throw new Refusal('SNAPSHOT_MODE', 'SKW_RENDER_MODE=snapshot must not write control.db');
  }
  const email = typeof flags.get('email') === 'string' ? (flags.get('email') as string) : undefined;
  const out = typeof flags.get('enrolment-out') === 'string' ? (flags.get('enrolment-out') as string) : undefined;
  if (email === undefined) throw new Refusal('USAGE', 'reset-totp requires --email <email>');
  if (out === undefined) throw new Refusal('SECRET_NOT_PRINTABLE', 'reset-totp requires --enrolment-out <path>');
  const url = adminUrl(ctx);

  const secret = newSecret();
  const db = openAdminWrite(ctx.controlPath, ctx.env.dbBusyTimeoutMs);
  let userId: number;
  try {
    requireSchemaVersion(db, ctx);
    const row = db
      .prepare('SELECT id, tenant_id, email, role FROM user_account WHERE email = ?')
      .get(email) as { id: number; tenant_id: number | null; email: string; role: string } | undefined;
    if (row === undefined) throw new Refusal('NO_CLAIM_TARGET', `no user_account row for ${email}`);
    if (row.role === 'fleet_admin' && !ctx.env.fleetMode) {
      throw new Refusal('FLEET_ADMIN_DISABLED', 'SKW_FLEET_MODE=0: this build has no fleet operators');
    }
    userId = row.id;
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      db.prepare('UPDATE user_account SET totp_secret = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').run(
        secret,
        userId,
      );
      db.prepare('UPDATE session SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId);
      db.prepare(
        `INSERT INTO audit_log (tenant_id, actor_user_id, actor_label, action, target_kind, target_id, after_json)
         VALUES (?, ?, 'install', 'admin.reset_totp', 'user_account', ?, '{"totp":"reset"}')`,
      ).run(row.tenant_id, userId, String(userId));
    });
    tx();
  } finally {
    db.close();
  }

  writeEnrolmentFile(out, enrolmentLines({ adminUrl: url, email, password: undefined, secret, action: 'admin reset-totp' }));
  ctx.stdout(`enrolment written: ${out} (0600, mode O_EXCL)`);
  ctx.stdout(`login: ${url}`);
  return EXIT_OK;
}

/** `skwctl admin reset-password --email <email> (--password-stdin | --generate-password)`. */
export async function resetPassword(ctx: CliContext, flags: Args['flags']): Promise<number> {
  if (ctx.env.renderMode === 'snapshot') {
    throw new Refusal('SNAPSHOT_MODE', 'SKW_RENDER_MODE=snapshot must not write control.db');
  }
  const email = typeof flags.get('email') === 'string' ? (flags.get('email') as string) : undefined;
  const out = typeof flags.get('enrolment-out') === 'string' ? (flags.get('enrolment-out') as string) : undefined;
  if (email === undefined) throw new Refusal('USAGE', 'reset-password requires --email <email>');
  const { password, generated } = await readPassword(ctx, flags, 'reset-password');
  if (generated && out === undefined) {
    throw new Refusal(
      'SECRET_NOT_PRINTABLE',
      'a generated password is a secret: pass --enrolment-out <path>, or --password-stdin',
    );
  }
  const passwordHash = await ctx.semaphore.run(() => hash(password, ARGON2_OPTIONS));

  const db = openAdminWrite(ctx.controlPath, ctx.env.dbBusyTimeoutMs);
  try {
    requireSchemaVersion(db, ctx);
    const row = db
      .prepare('SELECT id, tenant_id, email, role FROM user_account WHERE email = ?')
      .get(email) as { id: number; tenant_id: number | null; email: string; role: string } | undefined;
    if (row === undefined) throw new Refusal('NO_CLAIM_TARGET', `no user_account row for ${email}`);
    if (row.role === 'fleet_admin' && !ctx.env.fleetMode) {
      throw new Refusal('FLEET_ADMIN_DISABLED', 'SKW_FLEET_MODE=0: this build has no fleet operators');
    }
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE user_account
            SET password_hash = ?, must_change = 0, reset_token_hash = NULL, reset_expires_at = NULL,
                failed_logins = 0, locked_until = NULL
          WHERE id = ?`,
      ).run(passwordHash, row.id);
      db.prepare('UPDATE session SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, row.id);
      db.prepare(
        `INSERT INTO audit_log (tenant_id, actor_user_id, actor_label, action, target_kind, target_id, after_json)
         VALUES (?, ?, 'install', 'admin.reset_password', 'user_account', ?, ?)`,
      ).run(row.tenant_id, row.id, String(row.id), JSON.stringify({ generated_password: generated }));
    });
    tx();
  } finally {
    db.close();
  }

  if (generated && out !== undefined) {
    writeEnrolmentFile(
      out,
      enrolmentLines({
        adminUrl: adminUrl(ctx),
        email,
        password,
        secret: '(unchanged — this command does not rotate the second factor)',
        action: 'admin reset-password',
      }),
    );
    ctx.stdout(`enrolment written: ${out} (0600, mode O_EXCL)`);
  }
  ctx.stdout(`login: ${adminUrl(ctx)}`);
  ctx.stdout(`email: ${email}`);
  ctx.stdout(`sessions revoked: yes (absolute cap ${SESSION_ABSOLUTE_MS / 3_600_000} h, E-18)`);
  return EXIT_OK;
}

/**
 * `skwctl audit seal|verify|status` — the operator's half of §9.6 (E-20).
 *
 *   - `seal` writes one seal per active tenant for a UTC day (default: the last day that ended,
 *       because a day that has not ended has no segment) and exits non-zero if any tenant could
 *       not be sealed. A day that is already sealed is **not** a failure: it prints the stored
 *       `sealed_at`/`late` and exits 0, because "this day is anchored" is the outcome wanted.
 *   - `seal --heal` backfills every unsealed day through yesterday, one `audit_log` row per day.
 *   - `verify` walks **one day's segment** against its seal; `verify --chain` walks every link with
 *       no seal and answers the other question. The three refusals are named separately on stderr:
 *       `AUDIT_SEAL_UNSEALED`, `AUDIT_SEAL_MISMATCH`, `AUDIT_SEAL_EMPTY` (exit 0).
 *   - `status` prints the series and exits 1 when the chain is broken or any day is `UNSEALED`.
 */
async function audit(ctx: CliContext, verb: string | undefined, flags: Map<string, string | true>): Promise<number> {
  const dayFlag = flags.get('day');
  const day = typeof dayFlag === 'string' ? dayFlag : undefined;
  if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Refusal('USAGE', '--day is YYYY-MM-DD');
  const tenantFlag = flags.get('tenant');
  const tenant = typeof tenantFlag === 'string' ? tenantFlag : undefined;

  if (verb === 'seal') {
    if (flags.get('heal') === true) {
      const report = healGaps({
        dataDir: ctx.env.dataDir,
        ...(tenant === undefined ? {} : { tenant }),
        ...(day === undefined ? {} : { fromDay: day }),
      });
      for (const result of report.tenants) {
        if (result.error !== undefined) {
          ctx.stderr(`heal: tenant=${result.key} REFUSED ${result.error.code}: ${result.error.message}`);
          continue;
        }
        if (result.healed.length === 0) {
          ctx.stdout(`heal: tenant=${result.key} nothing to seal through ${report.throughDay}`);
          continue;
        }
        for (const healedDay of result.healed) {
          ctx.stdout(
            `heal: tenant=${result.key} day=${healedDay.day} rows_in_day=${healedDay.rows_in_day} late=${healedDay.late === 1 ? 'yes' : 'no'} sealed_at=${healedDay.sealed_at}`,
          );
        }
      }
      if (report.tenants.some((t) => t.error !== undefined)) {
        throw new Refusal('AUDIT_SEAL_FAILED', `a tenant could not be healed through ${report.throughDay}`);
      }
      return EXIT_OK;
    }

    const target = day ?? lastEndedDay();
    const report = sealDay({ dataDir: ctx.env.dataDir, day: target, ...(tenant === undefined ? {} : { tenant }) });
    let refused = 0;
    for (const result of report.tenants) {
      if (result.error !== undefined) {
        refused += 1;
        ctx.stderr(`seal: tenant=${result.key} day=${report.day} REFUSED ${result.error.code}: ${result.error.message}`);
        continue;
      }
      if (result.status === 'empty') {
        ctx.stdout(`seal: tenant=${result.key} day=${report.day} empty (0 rows on that day; no seal is required)`);
        continue;
      }
      const how = result.status === 'sealed' ? 'sealed' : 'already_sealed (no write)';
      ctx.stdout(
        `seal: tenant=${result.key} day=${report.day} ${how} rows_in_day=${result.rows_in_day} first_id=${String(result.first_id)} last_id=${String(result.last_id)} late=${result.late === 1 ? 'yes' : 'no'} sealed_at=${String(result.sealed_at)}`,
      );
    }
    if (refused > 0) {
      throw new Refusal('AUDIT_SEAL_FAILED', `${refused} tenant(s) could not be sealed for ${report.day}`);
    }
    return EXIT_OK;
  }

  if (verb === 'verify') {
    if (tenant === undefined) throw new Refusal('USAGE', 'audit verify needs --tenant <key>');
    const control = new Database(ctx.controlPath);
    try {
      const row = control.prepare('SELECT key FROM tenant WHERE key = ?').get(tenant) as { key: string } | undefined;
      if (row === undefined) throw new Refusal('TENANT_UNKNOWN', `no tenant ${tenant}`);
      const db = openAdminWrite(join(ctx.env.dataDir, 'tenants', tenant, 'site.db'));
      try {
        if (flags.get('chain') === true) {
          // The other question: every link, no seal. It is what an operator runs after a refusal,
          // and it is the only path that reads past a segment.
          const walk = verifyChain(db);
          if (!walk.ok) {
            throw new Refusal(
              'AUDIT_SEAL_CHAIN',
              `SKW_E_SEC_AUDIT_SEAL: the chain of ${tenant} is broken at row ${String(walk.brokenAt)}`,
            );
          }
          ctx.stdout(`chain: tenant=${tenant} ok rows=${walk.rows} head=${walk.head}`);
          return EXIT_OK;
        }
        const target = day ?? lastEndedDay();
        const verdict = verifyAgainstSeal(db, control, tenant, target);
        if (verdict.status === 'empty') {
          ctx.stdout(`empty: tenant=${tenant} day=${target} 0 rows on that day; no seal is required`);
          return EXIT_OK;
        }
        ctx.stdout(
          `verified: tenant=${tenant} day=${target} rows_in_day=${verdict.rows_in_day} first_id=${verdict.first_id} last_id=${verdict.last_id} late=${verdict.late === 1 ? 'yes' : 'no'} sealed_at=${verdict.seal.sealed_at}`,
        );
        return EXIT_OK;
      } catch (err) {
        if (err instanceof Refusal) throw err;
        const e = err as { code?: string; message?: string; detail?: { reason?: string } };
        const reason = e.detail?.reason ?? '';
        const detail = `${e.code ?? 'SKW_E_SEC_AUDIT_SEAL'}: ${e.message ?? String(err)}`;
        if (reason === 'unsealed') throw new Refusal('AUDIT_SEAL_UNSEALED', detail);
        throw new Refusal('AUDIT_SEAL_MISMATCH', detail);
      } finally {
        db.close();
      }
    } finally {
      control.close();
    }
  }

  if (verb === 'status') {
    if (tenant === undefined) throw new Refusal('USAGE', 'audit status needs --tenant <key>');
    const daysFlag = flags.get('days');
    const window = typeof daysFlag === 'string' ? Number(daysFlag) : 5;
    if (!Number.isInteger(window) || window < 1 || window > 400) throw new Refusal('USAGE', '--days is 1..400');
    const report = sealStatus({ dataDir: ctx.env.dataDir, tenantKey: tenant, days: window });
    ctx.stdout(`tenant=${report.tenant} chain=${report.chain.ok ? 'ok' : `broken at row ${String(report.chain.brokenAt)}`}`);
    for (const entry of report.days) {
      if (entry.state === 'sealed') {
        ctx.stdout(
          `${entry.day} sealed    rows_in_day=${String(entry.rows_in_day).padEnd(5)} first_id=${String(entry.first_id)} last_id=${String(entry.last_id)} late=${entry.late === 1 ? 'yes' : 'no'}${entry.late === 1 ? `  sealed_at=${String(entry.sealed_at)}` : ''}`,
        );
      } else if (entry.state === 'UNSEALED') {
        ctx.stdout(`${entry.day} UNSEALED  ${entry.rows_in_day} rows on that day; no seal`);
      } else {
        ctx.stdout(`${entry.day} empty     ${entry.rows_in_day} rows on that day; no seal is required`);
      }
    }
    if (!report.chain.ok) return EXIT_REFUSED;
    if (report.unsealed.length > 0) return EXIT_REFUSED;
    return EXIT_OK;
  }

  throw new Refusal('USAGE', 'usage: skwctl audit (seal [--heal] | verify [--chain] | status) [--tenant <key>] [--day YYYY-MM-DD] [--days N]');
}

/**
 * §8.5's install screen, rendered for a person who is not a developer.
 *
 * The order is the spec's: publisher and fingerprint, every capability in plain words, every
 * table and whether it exports, whether the package is first-party, and the test report's
 * timestamp and digest. Nothing here is generated from the package's own strings except the
 * ids — the plain words come from `CAPABILITY_TEXT`, so a package cannot describe its own
 * power in its own language.
 */
function screenLines(screen: InstallScreen): string[] {
  const lines: string[] = [];
  const pad = (label: string): string => `  ${label.padEnd(17)}`;
  lines.push('');
  lines.push(`install screen — ${screen.plugin}@${screen.version}`);
  if (screen.description !== null) lines.push(`${pad('what it is')}${screen.description}`);
  lines.push(`${pad('publisher')}${screen.publisher}`);
  lines.push(
    `${pad('key fingerprint')}${screen.publisher_key_fingerprint ?? '(none — unsigned)'}` +
      (screen.key_source === 'image'
        ? '   [the key baked into this image]'
        : screen.key_source === 'imported'
          ? '   [imported by the tenant owner into data/trust/publishers.json]'
          : ''),
  );
  lines.push(`${pad('first-party')}${screen.first_party ? 'yes' : screen.unsigned ? 'no — and unsigned' : 'no'}`);
  lines.push(
    `${pad('signature')}${
      screen.signature === null
        ? 'none — no key vouches for these bytes'
        : `${screen.signature.algorithm} over ${screen.signature.files} file(s), root ${screen.signature.root_hash}`
    }`,
  );
  lines.push(
    `${pad('test report')}${screen.test_report.ran_at}  sha256:${screen.test_report.sha256.slice(0, 16)}…  runner ${screen.test_report.runner_image_digest}`,
  );
  if (screen.capabilities.length === 0) {
    lines.push(`${pad('capabilities')}none — it can reach neither this site's data nor its mailer`);
  } else {
    lines.push(`${pad('capabilities')}${screen.capabilities.length} granted:`);
    for (const cap of screen.capabilities) lines.push(`                     ${cap.op.padEnd(16)}${cap.plain}`);
  }
  if (screen.tables.length === 0) {
    lines.push(`${pad('tables')}none`);
  } else {
    for (const table of screen.tables) lines.push(`${pad('tables')}${table.name}  (exports: ${table.export})`);
  }
  if (screen.settings.length > 0) {
    lines.push(`${pad('settings')}${screen.settings.map((s) => `${s.key} (${s.type}${s.secret ? ', write-only' : ''})`).join(', ')}`);
  }
  if (screen.endpoints.length > 0) {
    lines.push(`${pad('public URLs')}${screen.endpoints.map((e) => `${e.method} /_plugin/${screen.plugin}/${e.name}`).join(', ')}`);
  }
  if (screen.unsigned) {
    lines.push('');
    lines.push('  *** UNSIGNED — no key this install trusts vouches for this package.            ***');
    lines.push('  *** You passed --allow-unsigned. The install row is signature_state=unsigned    ***');
    lines.push('  *** and the audit chain records allow_unsigned=true.                           ***');
  }
  lines.push('');
  return lines;
}

/**
 * `skwctl plugin …` — the operator surface S4d lacked.
 *
 * §8.2's install row is an operator decision: which third-party code runs on the client's
 * site, at which root, enabled or not. S4d shipped `installPlugin()` as a library call and
 * an exporter that ships `data/plugins/<id>/`, but nothing a person with shell access can
 * run — so a plugin could not be installed on a running box at all.
 *
 * It is a CLI verb and **not** an HTTP route on purpose: the admin surface belongs to the
 * tenant's owner, and the package on disk is root-owned, read-only to the app. This command
 * runs as the account that can write `<data>/plugins`, and every write it makes is audited
 * with `actor_label = 'skwctl'` (there is no logged-in user in a shell).
 */
async function plugin(ctx: CliContext, verb: string | undefined, args: Args): Promise<number> {
  const tenantFlag = args.flags.get('tenant');
  const tenant = typeof tenantFlag === 'string' ? tenantFlag : undefined;
  if (tenant === undefined) {
    throw new Refusal('USAGE', `plugin ${verb ?? ''} needs --tenant <key>`.replace('  ', ' '));
  }
  const siteDb = join(ctx.env.dataDir, 'tenants', tenant, 'site.db');
  if (!existsSync(siteDb)) throw new Refusal('TENANT_UNKNOWN', `no tenant ${tenant} at ${siteDb}`);
  const pluginsRoot = join(ctx.env.dataDir, 'plugins');
  const actor = { userId: null, label: 'skwctl' };

  if (verb === 'install') {
    const sourceDir = args.command[2];
    if (sourceDir === undefined) throw new Refusal('USAGE', 'plugin install needs a package directory');
    const reportFlag = args.flags.get('test-report');
    const digestFlag = args.flags.get('runner-digest');
    const signatureFlag = args.flags.get('signature');
    const allowUnsigned = args.flags.get('allow-unsigned') === true;
    const trustDir = join(ctx.env.dataDir, 'trust');
    const base = {
      siteDb,
      pluginsRoot,
      sourceDir,
      trustDir,
      ...(typeof reportFlag === 'string' ? { testReportPath: reportFlag } : {}),
      ...(typeof digestFlag === 'string' ? { runnerImageDigest: digestFlag } : {}),
      ...(typeof signatureFlag === 'string' ? { signaturePath: signatureFlag } : {}),
    };
    let result;
    try {
      // §8.5's screen, **before** anything is enabled: the trust decision is a decision, and
      // a decision printed after the write is a receipt. `inspectPackage` runs the whole
      // matrix and writes nothing; `installPlugin` then runs it again on the same bytes.
      const inspected = inspectPackage({ ...base, allowUnsigned });
      for (const line of screenLines(inspected.screen)) ctx.stdout(line);
      result = installPlugin({ ...base, allowUnsigned, enable: args.flags.get('enable') === true });
    } catch (err) {
      if (err instanceof AppError) throw new Refusal('PLUGIN_REFUSED', `${err.code}: ${err.message}`);
      throw err;
    }
    // The install transaction belongs to `installPlugin`; the audit row follows it on the
    // same connection. A crash between them leaves an install that is not audited — visible
    // to `audit verify` as a gap, never as a silent grant.
    const db = openAdminWrite(siteDb, ctx.env.dbBusyTimeoutMs);
    try {
      appendAudit(db, actor, 'plugin.install', 'cms_plugin_installed', result.plugin, null, {
        version: result.version,
        root_hash: result.root_hash,
        enabled: result.enabled,
        publisher: result.publisher,
        publisher_key_fingerprint: result.publisher_key_fingerprint,
        signature_state: result.signature_state,
        // D27: the one fact that must survive a later reading of the chain. `true` here is an
        // operator who chose to run code nobody vouched for, and the report quotes this row.
        allow_unsigned: result.unsigned,
      });
    } finally {
      db.close();
    }
    ctx.stdout(
      `plugin: installed id=${result.plugin} version=${result.version} root=${result.root_hash} enabled=${
        result.enabled ? 'yes' : 'no'
      } package=${result.package_dir}`,
    );
    if (result.unsigned) {
      ctx.stdout('plugin: *** UNSIGNED *** this package is not vouched for by any key; the audit row records allow_unsigned=true');
    }
    // The runner scans `<data>/plugins` **at start** (runner/server.mjs) and holds the
    // package list; the app reads the row per request, but the code is not loaded until
    // the runner restarts. Say so, rather than leaving a green install that 500s on first
    // render — the exact failure mode `bundle_verify` refuses for.
    ctx.stdout(`plugin: the runner scans ${pluginsRoot} at start; restart the runner service to load ${result.plugin}`);
    return EXIT_OK;
  }

  if (verb === 'trust') {
    const action = args.command[2];
    const trustDir = join(ctx.env.dataDir, 'trust');
    if (action === 'import') {
      const keyPath = args.command[3];
      if (keyPath === undefined) throw new Refusal('USAGE', 'plugin trust import needs a public key file (SPKI PEM, as `openssl pkey -pubout` writes)');
      const publisherFlag = args.flags.get('publisher');
      if (typeof publisherFlag !== 'string') throw new Refusal('USAGE', 'plugin trust import needs --publisher <id>');
      if (!existsSync(keyPath)) throw new Refusal('USAGE', `no such key file: ${keyPath}`);
      let imported;
      try {
        imported = importPublisherKey({
          trustDir,
          publisher: publisherFlag,
          spkiPem: readFileSync(keyPath, 'utf8'),
          importedBy: actor.label,
          ...(args.flags.get('replace') === true ? { replace: true } : {}),
        });
      } catch (err) {
        if (err instanceof AppError) throw new Refusal('PLUGIN_REFUSED', `${err.code}: ${err.message}`);
        throw err;
      }
      const db = openAdminWrite(siteDb, ctx.env.dbBusyTimeoutMs);
      try {
        appendAudit(db, actor, 'plugin.trust.import', 'plugin_publisher', imported.key.id, imported.replaced, {
          fingerprint: imported.key.fingerprint,
          trust_file: join(trustDir, 'publishers.json'),
        });
      } finally {
        db.close();
      }
      ctx.stdout(`plugin: imported publisher=${imported.key.id} fingerprint=${imported.key.fingerprint}`);
      ctx.stdout(`plugin: ${imported.total} key(s) in ${join(trustDir, 'publishers.json')} (0600); this file is the install's whole trust decision`);
      if (imported.replaced !== null) {
        ctx.stdout(`plugin: replaced ${imported.replaced.fingerprint} — packages signed by that key are now refused`);
      }
      return EXIT_OK;
    }
    if (action === 'list') {
      const keys = readTrustStore(trustDir);
      if (keys.length === 0) {
        ctx.stdout(`plugin: tenant=${tenant} no publisher keys imported; only first-party packages verify`);
        return EXIT_OK;
      }
      for (const key of keys) {
        ctx.stdout(`plugin: publisher=${key.id} fingerprint=${key.fingerprint} imported_at=${key.imported_at} by=${key.imported_by}`);
      }
      return EXIT_OK;
    }
    throw new Refusal('USAGE', 'usage: skwctl plugin trust (import <key.pem> --publisher <id> [--replace] | list) --tenant <key>');
  }

  if (verb === 'enable' || verb === 'disable') {
    const id = args.command[2];
    if (id === undefined) throw new Refusal('USAGE', `plugin ${verb} needs a plugin id`);
    const enable = verb === 'enable';
    const db = openAdminWrite(siteDb, ctx.env.dbBusyTimeoutMs);
    try {
      const row = db
        .prepare('SELECT id, plugin_id, version, root_hash, enabled, test_report_sha FROM cms_plugin_installed WHERE plugin_id = ?')
        .get(id) as
        | { id: number; plugin_id: string; version: string; root_hash: string; enabled: number; test_report_sha: string | null }
        | undefined;
      if (row === undefined) throw new Refusal('PLUGIN_UNKNOWN', `no cms_plugin_installed row for ${id}`);
      if (enable) {
        // The same two preconditions `assertEnabled()` enforces at render time, refused
        // here so the operator learns before the client's first page view.
        if (row.test_report_sha === null || row.test_report_sha === '') {
          throw new Refusal('PLUGIN_REFUSED', `${id} has no test report; a package nobody ran cannot be granted`);
        }
        if (!existsSync(join(pluginsRoot, id, 'plugin.json'))) {
          throw new Refusal('PLUGIN_REFUSED', `no package at ${join(pluginsRoot, id)}; install it before enabling it`);
        }
      }
      const at = new Date().toISOString();
      const tx = db.transaction(() => {
        db.prepare('UPDATE cms_plugin_installed SET enabled = ?, enabled_at = ? WHERE id = ?').run(enable ? 1 : 0, enable ? at : null, row.id);
        appendAudit(db, actor, `plugin.${enable ? 'enable' : 'disable'}`, 'cms_plugin_installed', id, { enabled: row.enabled === 1 }, { enabled: enable });
      });
      tx();
      ctx.stdout(`plugin: ${enable ? 'enabled' : 'disabled'} id=${id} version=${row.version} root=${row.root_hash}`);
      return EXIT_OK;
    } finally {
      db.close();
    }
  }

  if (verb === 'uninstall') {
    const id = args.command[2];
    if (id === undefined) throw new Refusal('USAGE', 'plugin uninstall needs a plugin id');
    const archiveFlag = args.flags.get('archive-dir');
    let result;
    try {
      result = uninstallPlugin({
        siteDb,
        pluginsRoot,
        pluginId: id,
        ...(typeof archiveFlag === 'string' ? { archiveDir: archiveFlag } : {}),
      });
    } catch (err) {
      if (err instanceof AppError) throw new Refusal('PLUGIN_REFUSED', `${err.code}: ${err.message}`);
      throw err;
    }
    // The audit row is written after the uninstall committed (the same order as install: the
    // transaction owns the rows, the audit follows on the same connection).
    const db = openAdminWrite(siteDb, ctx.env.dbBusyTimeoutMs);
    try {
      appendAudit(db, actor, 'plugin.uninstall', 'cms_plugin_installed', result.plugin, {
        version: result.version,
        root_hash: result.root_hash,
      }, { archive: result.archive_path, tables: result.tables.map((t) => t.name) });
    } finally {
      db.close();
    }
    ctx.stdout(
      `plugin: uninstalled id=${result.plugin} version=${result.version} root=${result.root_hash} ` +
        `tables=${result.tables.map((t) => `${t.name}(${t.rows})`).join(',') || 'none'} settings=${result.settings}`,
    );
    ctx.stdout(`plugin: archive ${result.archive_path} (0600; table-scoped, restore by hand)`);
    ctx.stdout(
      `plugin: package ${result.package_removed ? 'removed' : 'was already absent'}; its endpoint is 404 from the next request`,
    );
    // The runner holds the package list from its own start; a removed tree is refused at the
    // next restart, and the host refuses the endpoint immediately (no row). Say which half is
    // which, so "uninstalled" and "not loaded" cannot be confused.
    ctx.stdout(`plugin: restart the runner service to release the code for ${result.plugin}`);
    return EXIT_OK;
  }

  if (verb === 'list') {
    const db = openAdminWrite(siteDb, ctx.env.dbBusyTimeoutMs);
    try {
      const rows = installedPlugins(db);
      if (rows.length === 0) {
        ctx.stdout(`plugin: tenant=${tenant} none installed`);
        return EXIT_OK;
      }
      for (const row of rows) {
        ctx.stdout(
          `plugin: tenant=${tenant} row=${row.id} id=${row.plugin_id} version=${row.version} enabled=${
            row.enabled ? 'yes' : 'no'
          } root=${row.root_hash}`,
        );
      }
      return EXIT_OK;
    } finally {
      db.close();
    }
  }

  throw new Refusal(
    'USAGE',
    'usage: skwctl plugin (install <dir> [--signature <file>] [--allow-unsigned] [--test-report <path>] [--runner-digest <sha>] [--enable] | trust (import <key.pem> --publisher <id> [--replace] | list) | enable <id> | disable <id> | uninstall <id> [--archive-dir <dir>] | list) --tenant <key>',
  );
}

export async function run(argv: readonly string[], ctx: CliContext): Promise<number> {
  if (argv.length === 0) {
    throw new Refusal(
      'USAGE',
      'usage: skwctl <admin (bootstrap | reset-totp | reset-password) [--email <email>] [--enrolment-out <path>] | audit (seal [--heal] | verify [--chain] | status) [--tenant <key>] [--day YYYY-MM-DD] [--days N] | plugin (install <dir> | trust (import <key.pem> --publisher <id> | list) | enable <id> | disable <id> | uninstall <id> | list) --tenant <key>>',
    );
  }
  const args = parseArgs(argv);
  if (args.command[0] === 'audit') {
    return audit(ctx, args.command[1], args.flags);
  }
  if (args.command[0] === 'plugin') {
    return plugin(ctx, args.command[1], args);
  }
  if (args.command[0] !== 'admin') {
    throw new Refusal(
      'USAGE',
      `unknown command ${args.command.join(' ') || '(none)'}; expected "admin <verb>", "audit <verb>" or "plugin <verb>"`,
    );
  }
  const verb = args.command[1];
  switch (verb) {
    case 'bootstrap':
      return bootstrap(ctx, args.flags);
    case 'reset-totp':
      return resetTotp(ctx, args.flags);
    case 'reset-password':
      return resetPassword(ctx, args.flags);
    default:
      throw new Refusal('USAGE', `unknown admin verb ${verb ?? '(none)'}; expected bootstrap, reset-totp or reset-password`);
  }
}

function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return fileURLToPath(metaUrl) === entry;
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  run(argv, makeContext())
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      if (err instanceof Refusal) {
        process.stderr.write(`REFUSAL: ${err.message}\n`);
        process.exit(err.exitCode);
      }
      const e = err as { code?: string; message?: string };
      process.stderr.write(`REFUSAL: INTERNAL: ${e.code ?? e.message ?? String(err)}\n`);
      process.exit(EXIT_REFUSED);
    });
}
