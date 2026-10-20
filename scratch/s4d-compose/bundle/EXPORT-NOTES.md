# Export notes — acme (CMS bundle)

<!-- The two `key: value` lines below are parsed by gates. Do not reflow them. -->

exported_at: 2026-10-21T00:00:00.000Z
projection_sha: dfa476b8b4fa0a264baa28166c4e9298145aaa7455541ea7eea26e5e14ba47b3:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945
content_sha: dfa476b8b4fa0a264baa28166c4e9298145aaa7455541ea7eea26e5e14ba47b3
media_sha: 4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945
pages: 1
assets: 0
origin: http://acme.test

## What this export is

Every page below was produced by the site's own render path (`renderStoredBody` → `renderBody` → the page shell), from the bytes in `cms_page.body_html`, at the projection above. The three targets share that projection: `projection_sha` is the same value in a CMS bundle, an Astro project and a static tree made from the same database and clock.

| path | title | body bytes | sha256 (body) |
|---|---|---|---|
| `/` | Acme home | 18 | `c314c64cee1e219b842cb08442598f0726f50eacdff6e2a1986d3ae6fda4c799` |

## Target

- **Run:** `tar xf`, then `./install.sh` (verify, `control.sql`, seed, `.env`, bootstrap, compose up).
- **Files:** 16 (this manifest lists every one that ships).
- **Projection:** `data/site.db` is `VACUUM INTO`, then the export projection applied: the
  `empty` tables carry no rows and the `filtered` ones carry no operator-only row.
- **No download plane of ours:** `cms_download_code`, `cms_download_event`, `cms_form_submission`,
  `cms_watermark_render`, `cms_audit` and `cms_plugin_revoked` ship empty, by class.
- **No `content/protected/`, no `content/sources/`, no `control.db`, no `-wal`, no `-shm`.**
- **First login:** `./install.sh --generate-password` writes an enrolment file; delete it after enrolling.

## Time

`exported_at:` above is the **only** place a date appears in this tree. Two exports of one database at one `SKW_EXPORT_NOW` are byte-identical; at two clocks they differ in that line and nothing else. A sitemap here carries no `lastmod`, because a `lastmod` would be a second timestamp that says something the export did not measure.
