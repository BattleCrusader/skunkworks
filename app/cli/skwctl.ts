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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARGON2_OPTIONS, Semaphore } from '../admin/auth.ts';
import { verifyAgainstSeal, utcDay } from '../audit/chain.ts';
import { sealDay } from '../audit/scheduler.ts';
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
  | 'AUDIT_SEAL_MISMATCH'
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
 * `skwctl audit seal|verify` — the operator's half of §9.6.
 *
 * `seal` writes one seal per active tenant for a UTC day (default today) and exits
 * non-zero if any tenant could not be sealed. `verify` walks the chain and compares
 * count and head to the seal; a mismatch is `SKW_E_SEC_AUDIT_SEAL` on stderr and
 * exit 1, never a warning.
 */
async function audit(ctx: CliContext, verb: string | undefined, flags: Map<string, string | true>): Promise<number> {
  const dayFlag = flags.get('day');
  const day = typeof dayFlag === 'string' ? dayFlag : utcDay();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Refusal('USAGE', '--day is YYYY-MM-DD');
  const tenantFlag = flags.get('tenant');
  const tenant = typeof tenantFlag === 'string' ? tenantFlag : undefined;

  if (verb === 'seal') {
    const report = sealDay({ dataDir: ctx.env.dataDir, day, ...(tenant === undefined ? {} : { tenant }) });
    let refused = 0;
    for (const result of report.tenants) {
      if (result.error !== undefined) {
        refused += 1;
        ctx.stderr(`seal: tenant=${result.key} day=${report.day} REFUSED ${result.error.code}: ${result.error.message}`);
        continue;
      }
      ctx.stdout(
        `seal: tenant=${result.key} day=${report.day} rows=${result.rows} head=${result.head}${result.created ? '' : ' (existing)'}`,
      );
    }
    if (refused > 0) {
      throw new Refusal('AUDIT_SEAL_MISMATCH', `${refused} tenant(s) could not be sealed for ${day}`);
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
        const report = verifyAgainstSeal(db, control, tenant, day);
        ctx.stdout(
          `verified: tenant=${tenant} day=${day} rows=${report.rows} head=${report.head} sealed_at=${report.seal?.sealed_at ?? ''}`,
        );
      } catch (err) {
        const e = err as { code?: string; message?: string };
        throw new Refusal('AUDIT_SEAL_MISMATCH', `${e.code ?? 'SKW_E_SEC_AUDIT_SEAL'}: ${e.message ?? String(err)}`);
      } finally {
        db.close();
      }
    } finally {
      control.close();
    }
    return EXIT_OK;
  }

  throw new Refusal('USAGE', 'usage: skwctl audit (seal | verify) [--tenant <key>] [--day YYYY-MM-DD]');
}

export async function run(argv: readonly string[], ctx: CliContext): Promise<number> {
  if (argv.length === 0) {
    throw new Refusal(
      'USAGE',
      'usage: skwctl <admin (bootstrap | reset-totp | reset-password) [--email <email>] [--enrolment-out <path>] | audit (seal | verify) [--tenant <key>] [--day YYYY-MM-DD]>',
    );
  }
  const args = parseArgs(argv);
  if (args.command[0] === 'audit') {
    return audit(ctx, args.command[1], args.flags);
  }
  if (args.command[0] !== 'admin') {
    throw new Refusal('USAGE', `unknown command ${args.command.join(' ') || '(none)'}; expected "admin <verb>" or "audit <verb>"`);
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
