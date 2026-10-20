/**
 * The nginx edge, emulated.
 *
 * C-2: nginx strips `/demo/<key>` and the app never rewrites a path. These
 * tests therefore cannot send `/demo/acme/whoami` straight at the app — that
 * would be the double-strip 404 the design forbids. This helper applies the two
 * rules from §5.2/§12.3 (the rewrite and the two header overrides) and then
 * talks to the app, exactly as nginx would. test/nginx-config.test.ts asserts
 * the real config contains these rules; this file only replays them.
 */
import { EDGE_TOKEN } from './fixture.ts';

// 40 characters, the same maximum as `tenant.key`'s CHECK (E-5).
export const DEMO_RE = /^\/demo\/([a-z0-9][a-z0-9-]{0,39})(\/[^?]*)?(\?.*)?$/;

export type EdgeRequest =
  | { kind: 'redirect'; status: 301; location: string }
  | { kind: 'proxied'; path: string; headers: Record<string, string> };

export function edge(url: string, opts: { edgeToken?: string } = {}): EdgeRequest {
  const token = opts.edgeToken ?? EDGE_TOKEN;
  const m = DEMO_RE.exec(url);
  if (m === null) return { kind: 'proxied', path: url, headers: {} };
  const key = m[1] as string;
  const rest = m[2]; // undefined when slash-less
  const query = m[3] ?? '';
  if (rest === undefined) {
    // location ~ ^/demo/(?<demo_key>...)$ { return 301 /demo/$demo_key/$is_args$args; }
    return { kind: 'redirect', status: 301, location: `/demo/${key}/${query}` };
  }
  // rewrite "^/demo/<key>/(.*)$" /$1 break;
  return {
    kind: 'proxied',
    path: `${rest}${query}`,
    headers: {
      'x-skunkworks-edge': token,
      'x-skunkworks-tenant': key,
      'x-forwarded-prefix': `/demo/${key}`,
    },
  };
}
