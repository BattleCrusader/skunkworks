/**
 * One CSP, four places (§10.5 / C-12, S4c).
 *
 * The policy is a **string constant plus one header line**, and every producer writes that
 * line verbatim:
 *
 *   1. the live site — Fastify's `onSend` sets `Content-Security-Policy` on every HTML
 *      response (`app/main.ts`);
 *   2. the static target — `security-headers.conf` in the tree;
 *   3. the Astro target — the same file, byte-identical;
 *   4. the CMS bundle — `snippets/skunk-csp.conf`, included by the generated vhost.
 *
 * The three files are **the same bytes** (`CSP_CONF`), which is why the gate can compare
 * sha256 rather than parse three formats. A policy that lives in four files and is compared
 * by eye is a policy that drifts; this one is compared by hash, and a mutation to any single
 * producer reddens `test/csp.test.ts`.
 *
 * Why a header and not a `<meta>`: §15.2 measured a render-time CSP hash at +0.044 ms
 * (+34 %) on an 83 KB body, and C-12 chose `script-src 'self'` with no nonce and no hash.
 * A `<meta>` policy also cannot carry `frame-ancestors` — browsers ignore it there — so the
 * header is the only place all seven directives are enforceable.
 *
 * `frame-src` is per tenant in the SDS's wording. v1 declares no frames for any tenant, so
 * the emitted value is `'none'`; the parameter exists so the day a tenant declares one, the
 * four places move together instead of the header becoming a special case.
 */

/** The frozen directive order. A reordering is a byte change and therefore a gate failure. */
export function cspDirectives(frameSrc: readonly string[] = []): string[] {
  const frames = frameSrc.length === 0 ? "'none'" : [...frameSrc].sort().join(' ');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: https:",
    `frame-src ${frames}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ];
}

export function cspPolicy(frameSrc: readonly string[] = []): string {
  return cspDirectives(frameSrc).join('; ');
}

/**
 * S7 — the **admin** document's policy: the same frozen policy, with one nonce added to
 * `script-src` and `style-src`.
 *
 * The admin's chrome is app-generated and ships one inline `<style>` (the Guided Cards
 * tokens) and, on the media library only, one small inline `<script>`. `style-src 'self'`
 * would block the first and the surface would render as bare markup — which is exactly
 * what it did before S7. A nonce is the narrowest mechanism that allows those two
 * elements and nothing else: an injected `<script>` in a page title or a tenant field is
 * escaped before it reaches the document, so it can never carry this request's nonce.
 *
 * This is not a change to C-12. C-12's "no nonce" is about *tenant page bodies*: there
 * the renderer emits islands as files, so a nonce would be machinery with nothing to
 * carry. Here there is exactly one inline element of each kind, in one generated
 * document, and the alternative (a stylesheet route) is a second request per screen.
 * The public site, the three exported trees and `snippets/skunk-csp.conf` keep
 * `cspPolicy()` byte for byte; only `text/html` under `/admin` and `/fleet` is scoped.
 */
export function cspPolicyWithNonce(nonce: string, frameSrc: readonly string[] = []): string {
  if (!/^[A-Za-z0-9+/=_-]{16,}$/.test(nonce)) throw new Error('cspPolicyWithNonce: not a nonce');
  return cspDirectives(frameSrc)
    .map((directive) =>
      directive === "script-src 'self'" || directive === "style-src 'self'"
        ? `${directive} 'nonce-${nonce}'`
        : directive,
    )
    .join('; ');
}

/**
 * The **editor** document's policy: the frozen policy with inline style allowed.
 *
 * The canvas is an iframe the editor writes into, so it inherits this document's policy — and
 * GrapesJS applies every Style Manager rule by inserting a `<style>` element into that iframe.
 * Under `style-src 'self'` those rules are dropped by the browser: a colour could be typed into
 * the panel, stored in the rule, and never paint. Measured before this: setting colour on an h1
 * through StyleManager.setStyle produced a rule and no change in getComputedStyle.
 *
 * A nonce cannot help — the element is created by GrapesJS at a moment this server does not
 * choose — and per CSP a nonce in the directive voids 'unsafe-inline', so the editor's document
 * carries 'unsafe-inline' and no nonce. The blast radius is one authenticated screen: the canvas
 * renders authored content inside a frame, and what it produces is stored as a served CSS file.
 * The tenant site, the exported trees and the nginx snippet keep `style-src 'self'` byte for byte.
 */
export function cspPolicyForEditor(frameSrc: readonly string[] = []): string {
  return cspDirectives(frameSrc)
    .map((directive) => (directive === "style-src 'self'" ? "style-src 'self' 'unsafe-inline'" : directive))
    .join('; ');
}

/** The header name, lowercase as HTTP/1.1 sends it. */
export const CSP_HEADER = 'content-security-policy';

/**
 * The one line every served target ships. `always` is load-bearing: an `add_header` without
 * it is not sent on a 4xx/5xx, and a 404 page is exactly where a reflected payload would
 * otherwise run.
 */
export function cspConf(policy: string = cspPolicy()): string {
  return (
    '# The site\'s Content-Security-Policy — generated by app/render/csp.ts; do not edit.\n' +
    '#\n' +
    '# The same line, byte for byte, in the live site\'s response header, this tree, and the\n' +
    "# CMS bundle's snippets/skunk-csp.conf (SDS §10.5, C-12). Include it in the server block\n" +
    '# that serves these pages:\n' +
    '#\n' +
    '#     include /etc/nginx/snippets/skunk-csp.conf;\n' +
    '\n' +
    `add_header Content-Security-Policy "${policy}" always;\n`
  );
}

/** `security-headers.conf`'s basename in the static and Astro trees. */
export const CSP_CONF_FILE = 'security-headers.conf';
