/**
 * analytics — first-party site analytics, collected from this site's own origin.
 *
 * The shape of the package is forced by the platform, and the constraints are worth stating
 * because each one shapes a decision below:
 *
 *   - **No headers reach an endpoint.** `runEndpoint` hands a package `{query, body, method,
 *     facade, ctx}` — no `User-Agent`, no `Referer`, no client address. So every fact about a
 *     visit is *reported by the browser*, and the server's only contribution is the clock.
 *   - **The body arrives as a string, and only when the host's parser left it one.** A
 *     `Content-Type: application/json` request is parsed into an object and reaches this handler
 *     as `''`. `navigator.sendBeacon(url, string)` sends `text/plain`, which is why the client
 *     uses that and why `'application/json'` bodies are refused here rather than half-handled.
 *   - **A hook cannot write.** `page.rendered` would be the obvious place to count a page and it
 *     has no facade at all (`registry.ts`'s `HookCall` is a plain object), so nothing is counted
 *     server-side. That is also why a crawler is not counted: it does not run the script.
 *   - **`page.head` is 4 KiB of markup with `script-src 'self'`.** The tracker is a file this
 *     package ships (`files[]` in the manifest), served at `/_plugin/analytics/f/t.js`, and the
 *     hook writes one `<script src>` tag. No inline code: the CSP has no nonce here.
 *
 * What this file refuses to do, deliberately:
 *
 *   - It stores no address, no user agent, no cookie and no name. `visitor` is 16 random bytes the
 *     client keeps in `localStorage`; `session` is another random value in `sessionStorage`.
 *   - It never trusts a timestamp from the client. `day` and `ts` are the server's (`util.now`),
 *     so a laptop with a wrong clock cannot write into a cohort that never existed.
 *   - It never echoes a payload back and never names a field's value in a refusal, for the reason
 *     `contact` gives: a reflection bug in a beacon is a tenant's origin serving an attacker's
 *     text.
 */
const VERSION = '1.0.3';

/** The table this package owns. `app/admin/analytics.ts` reads it; both name it in one place. */
const TABLE = 'p_analytics_event';

/** A request body over this is not a beacon: the host allows 16 KiB and a real one is ~300 B. */
const BODY_MAX_BYTES = 4 * 1024;

const KINDS = new Set(['pageview', 'click', 'engage', 'scroll']);
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const PATH_MAX = 400;
const URL_MAX = 800;
const TEXT_MAX = 120;
const KIND_MAX = 24;

/** Rows kept per prune pass, and the quiet period between passes. */
const PRUNE_ROWS = 100;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;

export function activate(ctx) {
  // ---------------------------------------------------------------- the script tag
  //
  // One dispatch per rendered page, and the whole of this package's public surface. `defer` so
  // the beacon never delays a paint; `data-e` so the script does not have to derive its own
  // endpoint from its own URL (it would get it right, and then a proxy rewrite would break it).
  ctx.on('page.head', (_call, value) => {
    const previous = typeof value === 'string' ? value : '';
    return `${previous}<script src="/_plugin/analytics/f/t.js?v=${VERSION}" defer data-e="/_plugin/analytics/collect"></script>`;
  });

  // ---------------------------------------------------------------- the collector
  ctx.endpoint('POST', 'collect', async (args) => {
    const raw = typeof args.body === 'string' ? args.body : '';
    if (raw === '' || utf8Bytes(raw) > BODY_MAX_BYTES) return { ok: false, error: 'body' };

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'body' };
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, error: 'body' };

    const checked = validate(payload);
    if (checked.ok !== true) return { ok: false, error: 'invalid', fields: checked.fields };

    // Paused is a settings flag, read on the write path rather than at render time because a
    // hook has no facade: the script keeps loading, and the collector refuses to record.
    if (args.facade['settings.get']('paused') === true) return { ok: true, skipped: 'paused' };

    const value = checked.value;
    const now = args.facade['util.now']();
    const day = now.slice(0, 10);
    // Acquisition is a property of the *pageview* and of nothing else. A click beacon carries no
    // referrer, so deriving a source for one produced `(direct)` on every press — a wrong value in
    // a column an operator reads, which is worse than an empty one.
    const origin = value.kind === 'pageview' ? sourceOf(value.url, value.referrer) : { source: null, medium: null, campaign: null };

    const row = {
      kind: value.kind,
      day,
      ts: now,
      session: value.session,
      visitor: value.visitor,
      path: value.path,
      url: value.url,
      referrer: value.referrer,
      source: origin.source,
      medium: origin.medium,
      campaign: origin.campaign,
      target: value.target,
      target_url: value.targetUrl,
      target_kind: value.targetKind,
      scroll: value.scroll,
      dwell_ms: value.dwell,
      vw: value.vw,
      vh: value.vh,
      device: value.device,
      browser: value.browser,
      os: value.os,
      lang: value.lang,
    };
    // A null column is written as null, not '' — "not reported" and "reported as empty" are
    // different facts and the dashboard's COALESCE() depends on the difference.
    for (const key of Object.keys(row)) if (row[key] === undefined) row[key] = null;

    try {
      args.facade['store.write'](TABLE, row);
    } catch (err) {
      // A write failure is not the visitor's problem and must not be a 500 that a beacon retries
      // forever. The operator sees it in the log; the browser is told "fine, move on".
      ctx.log(`collect insert failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, error: 'store' };
    }

    prune(args.facade, ctx, day);
    return { ok: true };
  });

  // A raw view of what was recorded. Declarative — the host draws it — so an operator can check a
  // number against the rows behind it, which is the first thing anyone does with a dashboard.
  ctx.screen({ path: '/analytics-events', table: TABLE, title: 'Analytics events' });
}

/**
 * Retention, without a scheduler: the collector prunes on its own traffic.
 *
 * One pass per module instance per hour, at most `PRUNE_ROWS` rows, oldest day first. A package
 * has no cron hook (§13.3.4 lists none) and a timer set at activation is exactly what the
 * activation recorder exists to make impossible, so the work rides the request that is already
 * happening. `retention_days` of 0 means "keep everything" and skips the query entirely.
 */
let lastPruneMs = 0;

function prune(facade, ctx, today) {
  const nowMs = Date.now();
  if (nowMs - lastPruneMs < PRUNE_EVERY_MS) return;
  const days = Number(facade['settings.get']('retention_days') ?? DEFAULT_RETENTION_DAYS);
  if (!Number.isFinite(days) || days <= 0) {
    lastPruneMs = nowMs;
    return;
  }
  lastPruneMs = nowMs;
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
  try {
    const found = facade['store.read'](TABLE, {
      where: [{ column: 'day', op: '<', value: cutoff }],
      order: { column: 'day', dir: 'asc' },
      limit: PRUNE_ROWS,
    });
    const rows = Array.isArray(found?.rows) ? found.rows : [];
    let removed = 0;
    for (const row of rows) {
      try {
        facade['store.delete'](TABLE, row.id);
        removed += 1;
      } catch {
        break;
      }
    }
    if (removed > 0) ctx.log(`retention: removed ${removed} rows older than ${cutoff}`);
  } catch (err) {
    // A prune that cannot run is a table that keeps its rows. Nothing a visitor can see.
    ctx.log(`retention skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Field checks, in a fixed order, answering the names of the fields that failed — never their
 * values. Everything is optional except the five facts a row cannot mean anything without:
 * what happened, in which session, to which visitor, on which path.
 */
function validate(payload) {
  const fields = [];

  const kind = text(payload.k, KIND_MAX);
  if (kind === null || !KINDS.has(kind)) fields.push('k');
  const session = typeof payload.sid === 'string' && ID.test(payload.sid) ? payload.sid : '';
  if (session === '') fields.push('sid');
  const visitor = typeof payload.vid === 'string' && ID.test(payload.vid) ? payload.vid : '';
  if (visitor === '') fields.push('vid');

  const path = text(payload.p, PATH_MAX);
  // A path is a path: root-relative, no space, no control character, no scheme-relative `//`.
  if (path === null || !path.startsWith('/') || path.startsWith('//') || /[\s\u0000-\u001f]/.test(path)) fields.push('p');

  const url = text(payload.u, URL_MAX);
  if (url !== null && !/^https?:\/\//i.test(url)) fields.push('u');

  if (fields.length > 0) return { ok: false, fields };

  return {
    ok: true,
    value: {
      kind,
      session,
      visitor,
      path,
      url: url ?? '',
      referrer: text(payload.r, URL_MAX) ?? '',
      target: text(payload.t, TEXT_MAX) ?? '',
      targetUrl: text(payload.tu, URL_MAX) ?? '',
      targetKind: text(payload.tk, KIND_MAX) ?? '',
      scroll: count(payload.sc, 0, 100),
      dwell: count(payload.dw, 0, 86_400_000),
      vw: count(payload.vw, 0, 100_000),
      vh: count(payload.vh, 0, 100_000),
      // Null when the browser did not report it. `''` was the first shape here and it made
      // "not reported" indistinguishable from a device with no name, which the dashboard then
      // drew as an empty row.
      device: text(payload.d, KIND_MAX),
      browser: text(payload.b, KIND_MAX),
      os: text(payload.o, KIND_MAX),
      lang: text(payload.l, KIND_MAX),
    },
  };
}

/** A trimmed string of at most `max`, or null when it is absent or not a string. */
function text(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.slice(0, max);
}

/** An integer in range, or null. A float, a NaN and a string are all "not reported". */
function count(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const whole = Math.round(n);
  if (whole < min || whole > max) return null;
  return whole;
}

/**
 * Where the visit came from: the campaign that named it, else the site that referred it, else
 * direct. `(internal)` is its own value — a visitor moving between two pages of this site has a
 * referrer, and counting that as a traffic source is how a site's own navigation pads its
 * acquisition numbers.
 */
function sourceOf(url, referrer) {
  let source = '(direct)';
  let medium = null;
  let campaign = null;

  // `utm_*` wins over the referrer: a campaign link posted on a site you also get organic
  // referrers from must be counted as the campaign.
  if (url !== '') {
    try {
      const params = new URL(url).searchParams;
      const utmSource = text(params.get('utm_source'), TEXT_MAX);
      if (utmSource !== null) {
        source = utmSource;
        medium = text(params.get('utm_medium'), KIND_MAX) ?? 'campaign';
        campaign = text(params.get('utm_campaign'), TEXT_MAX);
      }
    } catch {
      /* a URL that will not parse contributes no campaign, which is what it has */
    }
  }

  if (source === '(direct)' && referrer !== '') {
    try {
      const host = new URL(referrer).hostname.replace(/^www\./, '').toLowerCase();
      if (host !== '') {
        const own = url === '' ? '' : new URL(url).hostname.replace(/^www\./, '').toLowerCase();
        source = host === own ? '(internal)' : host;
        if (host !== own) medium = 'referral';
      }
    } catch {
      /* a referrer that will not parse is not a source */
    }
  }

  return { source, medium, campaign };
}

function utf8Bytes(value) {
  return new TextEncoder().encode(value).length;
}
