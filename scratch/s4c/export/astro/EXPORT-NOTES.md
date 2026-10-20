# Export notes — acme (Astro project)

<!-- The two `key: value` lines below are parsed by gates. Do not reflow them. -->

exported_at: 2026-10-20T12:00:00.000Z
projection_sha: b67ca3aadb525ef0051051c5c42a570f136c09638d82ae23de7e5945e02eb15e:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945
content_sha: b67ca3aadb525ef0051051c5c42a570f136c09638d82ae23de7e5945e02eb15e
media_sha: 4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945
pages: 2
assets: 0
origin: https://acme.test

## What this export is

Every page below was produced by the site's own render path (`renderStoredBody` → `renderBody` → the page shell), from the bytes in `cms_page.body_html`, at the projection above. The three targets share that projection: `projection_sha` is the same value in a CMS bundle, an Astro project and a static tree made from the same database and clock.

| path | title | body bytes | sha256 (body) |
|---|---|---|---|
| `/` | Acme home | 41 | `56b59f22cf91d52bde5aac02b418329e9cee57304a49758fc3005f5d20b7202f` |
| `/pricing` | Acme | 21 | `8b0dd353d52d1de06c1aac8a62ac35d3c6349686ca7cecfd44e0ce711bd4947c` |

## Target

- **Run:** `npm ci && npm run build`, then serve `dist/`. `npm run dev` edits live.
- **Astro** is pinned to the version the exporter resolved; `package-lock.json` is that
  lockfile filtered to the closure a static build needs — every `integrity` is the
  resolved one. No dependency of the *product* travels (no `better-sqlite3`, `fastify`,
  `grapesjs`, `pdf-lib`, `prettier`); `sharp` is in astro own closure, not ours.
- **No download plane:** a gated asset is refused at export (§11.3 #1), never omitted.

## Time

`exported_at:` above is the **only** place a date appears in this tree. Two exports of one database at one `SKW_EXPORT_NOW` are byte-identical; at two clocks they differ in that line and nothing else. A sitemap here carries no `lastmod`, because a `lastmod` would be a second timestamp that says something the export did not measure.
