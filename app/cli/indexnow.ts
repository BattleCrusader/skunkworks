#!/usr/bin/env node
/**
 * `skw-indexnow` — seed a site that already exists.
 *
 *     skw-indexnow --tenant <key> [--data-dir <dir>] [--list]
 *
 * A publish submits the page it published (`app/admin/routes.ts`). That is enough for a site
 * whose pages change from now on, and useless for a site that went live before IndexNow was
 * switched on: those pages are public, in `/sitemap.xml`, and unknown to the engines that would
 * otherwise wait for a crawl. This command submits **every URL the tenant's sitemap lists, right
 * now**, once, and prints the engine's answer and the count.
 *
 * The URL set is `collectSitemapEntries()` — the same function `GET /sitemap.xml` calls
 * (`app/render/sitemap.ts`). That is deliberate and is the one property this command has to have:
 * an operator's seed must announce exactly the site's own index, no more (no `/admin`, no
 * `/search`, no draft, no page scheduled for next week) and no less (the package-declared detail
 * pages, the job board's adverts). A second enumeration here would drift the first time either
 * side changed.
 *
 * The plugin runtime is constructed for this one run and its cached read handle is closed at the
 * end. `collectSitemapEntries()` calls `sync(tenant)`, which imports that tenant's enabled
 * packages — the same call the route makes — so a package's `/blog/{slug}` pages are in the set
 * without this file knowing what a blog is.
 *
 * Exit codes are the house's: 0 done (including "nothing to submit" and `SKW_INDEXNOW=off`),
 * 1 refused or the engine answered with an error, 2 bad usage.
 */
import Database from 'better-sqlite3';
import { join } from 'node:path';

import { openRenderRead } from '../db/classes.ts';
import { loadEnv } from '../env.ts';
import { INDEXNOW_ENDPOINT, indexNowPayload, postIndexNow } from '../indexnow/indexnow.ts';
import { PluginRuntime } from '../plugins/runtime.ts';
import { collectSitemapEntries } from '../render/sitemap.ts';

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;

interface Args {
  tenant: string | undefined;
  dataDir: string;
  /** Print the submitted URLs, one per line, after the summary. */
  list: boolean;
  help: boolean;
}

export function parse(argv: readonly string[]): Args {
  const args: Args = {
    tenant: undefined,
    dataDir: process.env.SKW_DATA_DIR ?? '.',
    list: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${String(flag)} needs a value`);
      i += 1;
      return next;
    };
    switch (flag) {
      case '--tenant':
        args.tenant = value();
        break;
      case '--data-dir':
        args.dataDir = value();
        break;
      case '--list':
        args.list = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`unknown flag ${JSON.stringify(String(flag))}`);
    }
  }
  return args;
}

const USAGE = [
  'usage: skw-indexnow --tenant <key> [--data-dir <dir>] [--list]',
  '',
  'Submits every URL the tenant sitemap lists to IndexNow, once.',
  'The key is derived from SKW_INDEXNOW_SECRET (or SKW_SESSION_KEY) and the tenant\'s primary host.',
].join('\n');

export interface SeedResult {
  host: string;
  key: string;
  keyLocation: string;
  urlCount: number;
  /** The submitted URLs, in the sitemap's order, for `--list`. */
  urls: string[];
  status: number | null;
  error?: string;
  /** True when `SKW_INDEXNOW=off`: a deliberate no-op, not a failure. */
  disabled?: boolean;
}

/** The tenant's public origin: its primary domain row, which is what a visitor's Host names. */
function primaryHost(control: Database.Database, tenant: string): string | null {
  const row = control
    .prepare(
      `SELECT d.host AS host
         FROM domain d JOIN tenant t ON t.id = d.tenant_id
        WHERE t.key = ? AND d.is_primary = 1`,
    )
    .get(tenant) as { host: string } | undefined;
  return row?.host ?? null;
}

async function seed(args: Args): Promise<SeedResult> {
  if (args.tenant === undefined || args.tenant === '') throw new Error('--tenant is required');

  // `role: 'migrate'` because this command is not the app: it needs the data directory, the mail
  // mode and the IndexNow secret, and it should not require the six boot keys a serving box needs.
  const env = loadEnv(process.env, { role: 'migrate' });
  if (env.indexNowSecret === '') {
    throw new Error('SKW_INDEXNOW_SECRET (or SKW_SESSION_KEY) is required to derive the key');
  }

  const control = new Database(join(args.dataDir, 'control.db'), { readonly: true });
  let host: string | null;
  try {
    host = primaryHost(control, args.tenant);
  } finally {
    control.close();
  }
  if (host === null) throw new Error(`no tenant ${JSON.stringify(args.tenant)} with a primary host in this data dir`);

  const origin = `https://${host}`;
  const payloadFor = (urls: readonly string[]): ReturnType<typeof indexNowPayload> =>
    indexNowPayload(origin, env.indexNowSecret, urls);

  const runtime = new PluginRuntime({ dataDir: args.dataDir, emailMode: env.emailMode });
  const db = openRenderRead(join(args.dataDir, 'tenants', args.tenant, 'site.db'), env.dbBusyTimeoutMs);
  let urls: string[];
  try {
    const entries = await collectSitemapEntries({
      db,
      tenantKey: args.tenant,
      origin,
      emailMode: env.emailMode,
      plugins: runtime,
    });
    urls = entries.map((entry) => entry.loc);
  } finally {
    db.close();
    runtime.closeSyncHandles();
  }

  const payload = payloadFor(urls);
  const base = { host: payload.host, key: payload.key, keyLocation: payload.keyLocation, urlCount: urls.length, urls };
  if (urls.length === 0) return { ...base, status: null };
  if (!env.indexNowEnabled) return { ...base, status: null, disabled: true };

  const result = await postIndexNow(payload);
  if (result.error === undefined) return { ...base, status: result.status };
  return { ...base, status: result.status, error: result.error };
}

async function main(argv: readonly string[]): Promise<number> {
  let args: Args;
  try {
    args = parse(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT_OK;
  }
  try {
    const result = await seed(args);
    process.stdout.write(`indexnow: ${result.keyLocation}\n`);
    if (result.urlCount === 0) {
      process.stdout.write(`indexnow: ${result.host} sitemap lists no urls — nothing submitted\n`);
      return EXIT_OK;
    }
    if (result.disabled === true) {
      process.stdout.write(`indexnow: ${result.host} ${result.urlCount} url(s) not submitted: SKW_INDEXNOW=off\n`);
      return EXIT_OK;
    }
    if (result.error !== undefined) {
      process.stdout.write(`indexnow: ${result.host} ${result.urlCount} url(s) status=${String(result.status)} error=${result.error}\n`);
      return EXIT_REFUSED;
    }
    process.stdout.write(`indexnow: ${result.host} ${result.urlCount} url(s) status=${String(result.status)}\n`);
    if (args.list) {
      for (const url of result.urls) process.stdout.write(`  ${url}\n`);
    }
    return EXIT_OK;
  } catch (err) {
    process.stderr.write(`skw-indexnow: ${(err as Error).message}\n`);
    return EXIT_REFUSED;
  }
}

// Run unconditionally, the way `skw-theme` and `skw-export` do: this file is an entry point, not a
// library, and an `import.meta.url === file://${process.argv[1]}` guard is itself a runtime-path
// decision the dist witness has to claim.
main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`skw-indexnow: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
