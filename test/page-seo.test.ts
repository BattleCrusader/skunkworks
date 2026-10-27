/**
 * Per-page search metadata, from `cms_page.seo_json` to the served `<head>`.
 *
 * The column existed from the first version of the page table and nothing read it, so a tenant
 * could set a title and nothing else. A crawlable page needs a description, a canonical URL and a
 * share card; a page body cannot carry them (the schema refuses `<script>` and `<style>` there by
 * design), and a `page.head` plugin cannot either — a hook callback receives `(call, value)` and
 * no store, because the `ctx` from `activate()` is closed by then. So the metadata lives on the
 * page's own row and the render reads it there.
 *
 *   SEO-1  a page with `seo_json` carries description, canonical and the Open Graph/Twitter card
 *   SEO-2  a JSON-LD document is emitted, parses, and is the document that was stored
 *   SEO-3  a page without it carries none of that — the document is what it was before
 *   SEO-4  a value cannot close the script element it is written into
 *   SEO-5  a `seo_json` that is not JSON is treated as absent, not as a broken page
 *   SEO-6  an explicit canonical and image win, and the card type follows the image
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { openAdminWrite } from '../app/db/classes.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, type Res } from './helpers/http.ts';

const TENANT = 'acme';
const HOST = 'acme.test';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;

function write(query: (db: ReturnType<typeof openAdminWrite>) => void): void {
  const db = openAdminWrite(fixture.sitePath(TENANT), 5000);
  try {
    query(db);
  } finally {
    db.close();
  }
}

async function get(path: string): Promise<Res> {
  return call({ port, path, host: HOST });
}

function head(body: string): string {
  const end = body.indexOf('</head>');
  assert.ok(end > 0, 'the document has a head');
  return body.slice(0, end);
}

before(async () => {
  fixture = makeFixture({
    specs: [{ key: TENANT, hosts: [HOST], title: 'Acme', body: '<h1>Fractional engineering</h1>' }],
  });
  handle = await buildApp({ env: loadEnv(fixture.env) });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

test('SEO-1. a page with seo_json carries a description, a canonical and a card', async () => {
  write((db) => {
    db.prepare(
      `UPDATE cms_page SET seo_json = ? WHERE path = '/pricing'`,
    ).run(
      JSON.stringify({
        title: 'Fractional engineering — Acme',
        description: 'Senior engineering capacity, two days a week, for companies that need the capability before the hire.',
      }),
    );
  });
  const res = await get('/pricing');
  assert.equal(res.status, 200);
  const h = head(res.body);
  assert.match(h, /<meta name="description" content="Senior engineering capacity, two days a week,/);
  assert.match(h, /<link rel="canonical" href="https:\/\/acme\.test\/pricing">/);
  assert.match(h, /<meta property="og:title" content="Fractional engineering — Acme">/);
  assert.match(h, /<meta property="og:url" content="https:\/\/acme\.test\/pricing">/);
  assert.match(h, /<meta property="og:locale" content="en_AU">/);
  assert.match(h, /<meta name="twitter:card" content="summary">/);
  assert.equal((h.match(/<meta name="description"/g) ?? []).length, 1, 'exactly one description');
});

test('SEO-2. a JSON-LD document is emitted once, and it is the document that was stored', async () => {
  write((db) => {
    const seo = {
      description: 'A studio of senior engineers.',
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'ProfessionalService',
        name: 'Acme',
        areaServed: 'Australia',
        serviceType: 'Software Engineering',
      },
    };
    db.prepare(`UPDATE cms_page SET seo_json = ? WHERE path = '/pricing'`).run(JSON.stringify(seo));
  });
  const res = await get('/pricing');
  const h = head(res.body);
  const blocks = [...h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 1, 'one structured-data block');
  const parsed = JSON.parse(blocks[0]?.[1] ?? 'null') as Record<string, unknown>;
  assert.equal(parsed['@type'], 'ProfessionalService');
  assert.equal(parsed.areaServed, 'Australia');
  assert.equal(parsed.serviceType, 'Software Engineering');
});

test('SEO-3. a page without seo_json carries none of it, byte for byte as before', async () => {
  write((db) => {
    db.prepare(`UPDATE cms_page SET seo_json = NULL WHERE path = '/pricing'`).run();
  });
  const res = await get('/pricing');
  assert.equal(res.status, 200);
  const h = head(res.body);
  assert.doesNotMatch(h, /name="description"/);
  assert.doesNotMatch(h, /rel="canonical"/);
  assert.doesNotMatch(h, /application\/ld\+json/);
  assert.doesNotMatch(h, /og:/);
});

test('SEO-4. a stored value cannot close the script element it is written into', async () => {
  write((db) => {
    db.prepare(`UPDATE cms_page SET seo_json = ? WHERE path = '/pricing'`).run(
      JSON.stringify({
        description: 'Short.',
        jsonLd: { '@type': 'Thing', name: '</script><img src=x onerror=alert(1)>', note: '<b>&</b>' },
      }),
    );
  });
  const res = await get('/pricing');
  const h = head(res.body);
  assert.doesNotMatch(h, /<img src=x/, 'no element was produced from the value');
  const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(h);
  assert.ok(block !== null, 'the block is still there');
  const text = block[1] as string;
  assert.match(text, /\\u003c\/script\\u003e/, 'every `<` is escaped');
  const parsed = JSON.parse(text) as { name: string; note: string };
  assert.equal(parsed.name, '</script><img src=x onerror=alert(1)>', 'and the value survives unchanged');
  assert.equal(parsed.note, '<b>&</b>');
});

test('SEO-5. a seo_json that is not JSON is treated as absent, not as a broken page', async () => {
  write((db) => {
    db.prepare(`UPDATE cms_page SET seo_json = '{not json' WHERE path = '/pricing'`).run();
  });
  const res = await get('/pricing');
  assert.equal(res.status, 200, 'the page still renders');
  assert.doesNotMatch(head(res.body), /name="description"/);
});

test('SEO-6. an explicit canonical and image win, and the card type follows the image', async () => {
  write((db) => {
    db.prepare(`UPDATE cms_page SET seo_json = ? WHERE path = '/pricing'`).run(
      JSON.stringify({
        description: 'A studio of senior engineers, working two days a week.',
        canonical: 'https://fractionalworks.com.au/engagements',
        image: 'https://fractionalworks.com.au/card.png',
      }),
    );
  });
  const res = await get('/pricing');
  const h = head(res.body);
  assert.match(h, /<link rel="canonical" href="https:\/\/fractionalworks\.com\.au\/engagements">/);
  assert.match(h, /<meta property="og:image" content="https:\/\/fractionalworks\.com\.au\/card\.png">/);
  assert.match(h, /<meta name="twitter:card" content="summary_large_image">/);
  const documentTitle = /<title>([^<]*)<\/title>/.exec(h)?.[1] ?? '';
  assert.ok(documentTitle !== '', 'the document has a title');
  assert.match(
    h,
    new RegExp(`<meta property="og:title" content="${documentTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">`),
    'the document title stands in when no social title is given',
  );
});
