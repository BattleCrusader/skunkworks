/**
 * **IndexNow** — telling the engines about a change the moment it happens, without a crawl.
 *
 * IndexNow is a key protocol, not an OAuth one: a site publishes a key at a URL **on its own
 * host**, and a submission names that key and that URL. The engine fetches the key file and, if
 * the bytes match, accepts the URLs. So the key is public by design — it is proof of control of
 * the host, not a credential — and the only secret here is the **input** it is derived from.
 *
 * ## The key is derived, not stored
 *
 *     key = sha256(secret + ':' + host), first 32 lowercase hex characters
 *
 * A stored key would be a row to back up, a rotation to coordinate across tenants and a value an
 * operator could mistype into a file that then 404s. A derived one is one function of two values
 * that already exist: the secret (`SKW_INDEXNOW_SECRET`, or `SKW_SESSION_KEY` when that is unset)
 * and the host the request arrived on. **The secret never leaves this module**: it is hashed and
 * the digest is truncated, and no log line in this file ever prints it.
 *
 * Each tenant therefore has its own key on its own host, and one tenant's key cannot be replayed
 * against another's site even though both are served by this process — the host is in the input.
 *
 * ## Submission never touches the request path
 *
 * A publish must answer with the page's new state whether or not the engine is reachable. So
 * `IndexNow.submit()` starts a POST and returns `void`: no `await` in a handler, no throw into it,
 * one log line afterwards saying what happened (`status=200`, `status=429`, or the error). The CLI
 * uses the same `postIndexNow()` directly because a one-shot seed *should* wait and print.
 *
 * ## `SKW_INDEXNOW=off`
 *
 * Off means "do not POST", and nothing else. The key route still answers: a key that 404s is a
 * claim the site does not control its own host, and a crawler that has cached that answer will
 * keep believing it long after the operator turns submission back on.
 */
import { createHash } from 'node:crypto';

/** The one endpoint. `api.indexnow.org` fans out to the participating engines. */
export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

/** A publish must not wait on a slow engine, and a hung socket must not be kept for a minute. */
export const INDEXNOW_TIMEOUT_MS = 5_000;

/**
 * The public key for one host: `sha256(secret + ':' + host)` truncated to 32 hex characters.
 *
 * Lowercase hex is the protocol's own alphabet, and the truncation is what the hosted key-file
 * name (`<key>.txt`) looks like in practice. Callers pass the **normalised** host — the same one
 * `normaliseHost()` gives the rest of the app — because `arnavia.com:443` and `arnavia.com` must
 * derive one key, not two.
 */
export function indexNowKey(secret: string, host: string): string {
  return createHash('sha256').update(`${secret}:${host}`).digest('hex').slice(0, 32);
}

/** Where the key lives: `https://<host>/<key>.txt`. The protocol calls this `keyLocation`. */
export function indexNowKeyLocation(origin: string, key: string): string {
  return `${origin}/${key}.txt`;
}

export interface IndexNowPayload {
  host: string;
  key: string;
  keyLocation: string;
  urlList: string[];
}

/** The JSON body, built once so the route, the publish path and the CLI cannot disagree. */
export function indexNowPayload(origin: string, secret: string, urls: readonly string[]): IndexNowPayload {
  const host = new URL(origin).host;
  const key = indexNowKey(secret, host);
  return { host, key, keyLocation: indexNowKeyLocation(origin, key), urlList: [...urls] };
}

export interface IndexNowResult {
  /** The engine's HTTP status, or null when the request never produced one. */
  status: number | null;
  /** How many URLs were in the body. */
  urlCount: number;
  /** The failure, verbatim, when there was one. Never includes the secret. */
  error?: string;
}

export interface PostOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * POST one submission and resolve with the outcome. **It does not throw**: a network failure, a
 * DNS failure, a 500 and a timeout are all results here, because every caller has worse things
 * to do with an exception than a log line.
 */
export async function postIndexNow(
  payload: IndexNowPayload,
  options: PostOptions = {},
): Promise<IndexNowResult> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const urlCount = payload.urlList.length;
  if (urlCount === 0) return { status: null, urlCount, error: 'no urls' };
  try {
    const res = await doFetch(INDEXNOW_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs ?? INDEXNOW_TIMEOUT_MS),
    });
    // The endpoint answers 200 or 202 on success and 4xx for a rejected key/URL list. A body is
    // not read: there is nothing in it this process acts on, and reading it would be one more
    // thing that can hang.
    const result: IndexNowResult = { status: res.status, urlCount };
    if (res.status >= 400) result.error = `status ${res.status}`;
    return result;
  } catch (err) {
    return { status: null, urlCount, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface IndexNowOptions {
  secret: string;
  /** `SKW_INDEXNOW !== 'off'`. Off disables the POST only — see the file header. */
  enabled: boolean;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The process's submitter: one instance, handed to the admin surface, so a publish can announce
 * without importing an HTTP client or knowing the endpoint.
 *
 * In-flight work is tracked **only** so a gate can await it (`whenIdle()`); nothing in the request
 * path reads that set. `submit()` cannot reject: `postIndexNow()` resolves every outcome.
 */
export class IndexNow {
  readonly enabled: boolean;
  readonly #secret: string;
  readonly #log: (line: string) => void;
  readonly #fetchImpl: typeof fetch | undefined;
  readonly #timeoutMs: number;
  readonly #inflight = new Set<Promise<void>>();

  constructor(options: IndexNowOptions) {
    this.enabled = options.enabled;
    this.#secret = options.secret;
    this.#log = options.log ?? ((line) => process.stdout.write(`${line}\n`));
    this.#fetchImpl = options.fetchImpl;
    this.#timeoutMs = options.timeoutMs ?? INDEXNOW_TIMEOUT_MS;
  }

  /** The public key for a host. Used by the key route; never logs its input. */
  keyFor(host: string): string {
    return indexNowKey(this.#secret, host);
  }

  keyLocation(origin: string): string {
    return indexNowKeyLocation(origin, this.keyFor(new URL(origin).host));
  }

  /**
   * Announce `urls` for `origin`. Returns immediately; the POST and its one log line happen after
   * the handler has answered.
   */
  submit(origin: string, urls: readonly string[]): void {
    const wanted = [...new Set(urls.filter((url) => url.startsWith(`${origin}/`)))];
    if (wanted.length === 0) return;
    if (!this.enabled) {
      this.#log(`indexnow: ${new URL(origin).host} skipped ${wanted.length} url(s): SKW_INDEXNOW=off`);
      return;
    }
    const run = this.#run(origin, wanted);
    this.#inflight.add(run);
    void run.finally(() => this.#inflight.delete(run));
  }

  /** A gate's hook: resolves when every POST this process started has finished. */
  async whenIdle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.all([...this.#inflight]);
  }

  async #run(origin: string, urls: readonly string[]): Promise<void> {
    const host = new URL(origin).host;
    try {
      const result = await postIndexNow(indexNowPayload(origin, this.#secret, urls), {
        ...(this.#fetchImpl === undefined ? {} : { fetchImpl: this.#fetchImpl }),
        timeoutMs: this.#timeoutMs,
      });
      if (result.error !== undefined) {
        this.#log(`indexnow: ${host} ${result.urlCount} url(s) failed: ${result.error}`);
      } else {
        this.#log(`indexnow: ${host} ${result.urlCount} url(s) submitted status=${String(result.status)}`);
      }
    } catch (err) {
      // `postIndexNow` is already total; this belt-and-braces line is here so that a future edit
      // which makes it throw still cannot reach a request that has already answered.
      this.#log(`indexnow: ${host} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
