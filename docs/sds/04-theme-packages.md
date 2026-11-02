# 04 — Theme packages: export, library, activation

Status: design, 2026-10-29. Slice after S12 (site archive/import).
Scope: a theme as a portable artefact; one copy of a theme on a box that many sites can wear.

## 1. What a theme is today

Measured on the box, not assumed:

| where | what |
|---|---|
| `cms_theme` (per `site.db`) | `theme_key`, `name`, `css_sha256 → cms_css_blob`, `source_name` |
| `cms_theme_asset` (per `site.db`) | `path`, `sha256`, `bytes`, `content_type`, unique on `(theme_id, path)` |
| `cms_css_blob` (per `site.db`) | the stylesheet bytes, content-addressed by sha256 |
| bytes | `data/tenants/<tenant>/theme-assets/<theme_key>/<path>` |
| URL | `/_theme/<theme_key>/<path>?v=<sha8>` |

The stylesheet is **rewritten on upload** (`rewriteAssetUrls`, `app/render/theme-bundle.ts`) so a
package's relative `url(assets/hero.woff2)` becomes the absolute `/_theme/<key>/assets/hero.woff2?v=…`.
That is what makes the blob content-addressed and the URL immutable — and it is why a theme is
already, in effect, half a package: the upload door accepts `.zip`, the door out does not exist.

Consequences today:

1. No way to export a theme. It travels only inside a CMS site bundle, at
   `data/tenants/<key>/theme-assets/…`.
2. No library. Two sites that want the same look each carry their own copy, uploaded twice, with
   independent drift.
3. `theme_key` is the URL identity, so two sites wearing "the same" theme already serve the same
   `/_theme/<key>/…` paths — the only thing missing is one copy of the bytes.

## 2. The package format (`skunkworks/theme/v1`)

A theme package is a directory (or a `.zip` of it) with exactly this shape:

```
theme.json          the manifest — the only file the importer trusts
theme.css           the stylesheet, with *relative* references: url(assets/hero.woff2)
assets/…            every file the stylesheet or the manifest names
```

`theme.json`:

```json
{
  "schema": "skunkworks/theme/v1",
  "key": "fractional-works",
  "name": "Fractional Works",
  "version": "1.0.0",
  "created_at": "2026-10-29T00:00:00.000Z",
  "css": { "path": "theme.css", "sha256": "…", "bytes": 8123 },
  "assets": [
    { "path": "assets/inter-latin.woff2", "sha256": "…", "bytes": 48432, "content_type": "font/woff2" },
    { "path": "assets/diagram.svg", "sha256": "…", "bytes": 2099, "content_type": "image/svg+xml" }
  ]
}
```

Rules the importer enforces, each with a named refusal:

- `schema` must be exactly `skunkworks/theme/v1` (`SKW_E_THEME_SCHEMA`).
- Every `sha256` is recomputed from the bytes and compared (`SKW_E_THEME_DIGEST`). A package that
  disagrees with itself is refused before anything is written.
- Paths are relative, `..`-free, not absolute, no symlinks (`SKW_E_THEME_PATH`). Same rule the
  upload door already applies, reused rather than re-implemented.
- Ceilings are the ones already in code: `THEME_MAX_BYTES` 512 KiB, `ASSET_MAX_BYTES` 8 MiB,
  `ASSETS_TOTAL_MAX_BYTES` 32 MiB, and the content-type allowlist (`contentTypeFor`).
- The stylesheet may reference only files the manifest declares. A reference to something absent is
  refused at import by name, because a package that 404s its own font is a broken look shipped with
  a checksum that says it is fine (`SKW_E_THEME_REF`).

**Why relative in the package and absolute at rest.** A package is portable; a rendered site is
fast. The importer performs the same rewrite the upload door performs, so the stored blob is still
content-addressed and the URL still immutable, while the artefact on disk names no host and no
tenant.

## 3. The library

`data/themes/<theme_key>/` — one copy per box, in the package format, plus a sibling
`data/themes/<theme_key>.json` index entry (key, name, version, css sha, asset count, installed_at,
`installed_from`). The library is **not** a tenant's assets: it is the box's stock of looks.

The renderer does not read the library. Rendering keeps reading `cms_css_blob`, `cms_theme` and the
tenant's `theme-assets/`, so **no render code changes** and no schema change is needed for this
slice. The library is a distribution point; activation is the copy-in step that already exists.

That is deliberate: the smallest change that makes themes global is to add a library and a copy
step, not to teach every render path about a second location.

## 4. Operations

```
skw-export --target theme --theme <key> --from tenant:<tenant>|library \
           --out <dir> [--archive <file.zip>] [--now <ISO8601>]

skwctl theme import <file.zip|dir> [--data-dir <dir>] [--replace]
skwctl theme list [--library | --tenant <tenant>]
skwctl theme activate <key> --tenant <tenant> [--data-dir <dir>] [--replace]
skwctl theme export <key> --tenant <tenant> --out <dir> [--archive <file.zip>]
```

- **export** reads the tenant (or the library), writes the package with `theme.css` rewritten back
  to *relative* references (the inverse of the upload rewrite), and reports the tree hash. With
  `--archive` it emits one file, deterministic: sorted entries, mtimes pinned to `--now`, 0644.
- **import** verifies the package (section 2), refuses a key collision whose bytes differ unless
  `--replace`, and writes the library entry. It touches no tenant.
- **activate** reads the library entry, writes `cms_css_blob` + `cms_theme` + `cms_theme_asset` rows
  in that tenant's DB, copies the bytes to `data/tenants/<tenant>/theme-assets/<key>/`, and sets
  `site.theme_key` to it when the tenant has no active theme. Refuses if the tenant already has the
  key with different bytes unless `--replace`.
- **list** prints what the box has and what each tenant wears.

## 5. Round trips that must hold (and are tested)

1. **Export is faithful.** A theme exported from tenant A carries the same CSS sha256 and the same
   per-asset sha256/bytes as the rows in A's `site.db`.
2. **Import then export is byte-identical.** `export(import(pkg)) == pkg` for a package produced by
   this exporter: same manifest (minus `created_at` if `--now` differs), same file bytes.
3. **A theme moves.** Exported from A, imported to the library, activated on B: B's `cms_theme.css_sha256`
   equals A's, every asset sha matches, and `/_theme/<key>/<path>` returns the same bytes on both
   hosts with the same `?v=` prefix.
4. **A package that lies is refused.** One flipped byte, a `..` path, a missing referenced asset, an
   unknown schema — each refuses by name, and nothing is written to the library or to a tenant.
5. **Determinism.** Two archives from one run at one `--now` are byte-identical (sha256 equal).

## 6. How this joins the site bundle

The CMS site bundle already embeds the theme (`data/tenants/<key>/theme-assets/…` plus the
`cms_theme*` rows). That stays: a site zip must be self-contained.

On **site import**: if the bundled theme key is missing from the library, the importer installs it
there (the same package builder runs on the extracted bytes) and then leaves the tenant's copy on
disk as the bundle carried it. So after importing one site, its theme is available to every other
site on the box with `skwctl theme activate` — which is the "global themes" behaviour asked for,
without making a site import depend on a library entry existing first.

On **site export**: unchanged in content, but `EXPORT-NOTES.md` will name the theme key and version
so a human can tell what look travels with the site.

## 7. Out of scope, stated

- Theme *marketplace*, remote registries, signing of theme packages. A theme is CSS and images; it
  is data, not code, and the box's plugin trust model does not apply to it.
- Per-page theme overrides. The active theme is per tenant.
- Sharing one theme's *bytes* between tenants on disk (a single copy served to many hosts). It is
  possible later — the URL is already host-relative and the key is stable — but it makes deletion
  and quota accounting tenant-dependent, and it is not needed to get portability.
