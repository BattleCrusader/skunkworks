# Export notes — acme (CMS bundle)

<!-- The two `key: value` lines below are parsed by gates. Do not reflow them. -->

exported_at: 2026-10-21T01:00:00.000Z
projection_sha: fa564d01fe824b992396230ea6955b5abbb28883d3b955869e556a613f4eb59b:c621302084642bc40edfa4449caed7790f3b03893afc28e3adf8a54139b2e6ad
content_sha: fa564d01fe824b992396230ea6955b5abbb28883d3b955869e556a613f4eb59b
media_sha: c621302084642bc40edfa4449caed7790f3b03893afc28e3adf8a54139b2e6ad
pages: 4
assets: 2
origin: https://acme.test

## What this export is

Every page below was produced by the site's own render path (`renderStoredBody` → `renderBody` → the page shell), from the bytes in `cms_page.body_html`, at the projection above. The three targets share that projection: `projection_sha` is the same value in a CMS bundle, an Astro project and a static tree made from the same database and clock.

| path | title | body bytes | sha256 (body) |
|---|---|---|---|
| `/` | Acme — the best widgets | 225 | `e3ddfb39c15d1ef55a6a4da99e400a4269d9e788a9025103f817a7897bf461a1` |
| `/about` | About & Co <ltd> | 151 | `a013a880c32cbec70ef4da7e1c103f2ff1e9135c811ba2daa987e8e70515566a` |
| `/legacy` | Legacy | 57 | `33ae84ce9ae40e63701ff0a5764d92b4f59891d52ee6b040817f309997c9ed58` |
| `/pricing` | Pricing | 60 | `872ac13c56ddbd255609a0acea1c1c52caf05897d1892518ad80acced7b0cf92` |

## Target

- **Run:** `tar xf`, then `./install.sh` (verify, `control.sql`, seed, `.env`, bootstrap, compose up).
- **Files:** 20 (this manifest lists every one that ships).
- **Projection:** `data/site.db` is `VACUUM INTO`, then the export projection applied: the
  `empty` tables carry no rows and the `filtered` ones carry no operator-only row.
- **No download plane of ours:** `cms_download_code`, `cms_download_event`, `cms_form_submission`,
  `cms_watermark_render`, `cms_audit` and `cms_plugin_revoked` ship empty, by class.
- **No `content/protected/`, no `content/sources/`, no `control.db`, no `-wal`, no `-shm`.**
- **First login:** `./install.sh --generate-password` writes an enrolment file; delete it after enrolling.

## Time

`exported_at:` above is the **only** place a date appears in this tree. Two exports of one database at one `SKW_EXPORT_NOW` are byte-identical; at two clocks they differ in that line and nothing else. A sitemap here carries no `lastmod`, because a `lastmod` would be a second timestamp that says something the export did not measure.
