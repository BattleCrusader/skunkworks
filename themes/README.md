# Themes

Stylesheets a site can be given from **Admin → Themes → Upload a theme**. Each one is a complete
`site.theme_css`: it styles the shell the host draws (`.site-header`, `.site-menu`, `.site-footer`)
and the `s-*` vocabulary the pages carry. Uploading stores the file once, keyed by its hash; exactly
one theme is active at a time (`site.theme_key`), and a theme can be previewed on the real page
before it is activated.

| file | ground | accent | notes |
|---|---|---|---|
| `midnight-kiln.css` | `#0c0d10` ink | `#ff7a4d` ember | Dark editorial. Paper-cream text, hairline rules, cards instead of boxes, one soft glow at the top of the page. Contrast measured: 16.13:1 body, 8.99:1 muted, 7.54:1 accent. |

## Two shapes, one door (S8x)

**A stylesheet** — one `.css` file, rules only. What the table above is.

**A package** — a `.zip` of a folder, when the look needs pictures or a display face:

```
my-theme/
  theme.css        ← required; the sheet
  theme.json       ← optional; {"name": "Editorial serif"}
  assets/
    hero.jpg
    face.woff2
```

`theme.css` must sit at the root of the archive (not inside a wrapper folder) and may reference the
package's files relatively:

```css
.s-hero { background-image: url(assets/hero.jpg); }
@font-face { font-family: "Kiln"; src: url(assets/face.woff2) format("woff2"); }
```

Those references are **rewritten when you upload**, once, to the absolute URL the browser will fetch:

```css
.s-hero { background-image: url("/_theme/midnight-kiln/assets/hero.jpg?v=8f3c1a02"); }
```

That is why the served sheet can be cached for a year, and why an export writes exactly the files its
documents name. A relative reference to a file the package does not contain is left alone: it will
404, which is the honest outcome of a broken package.

### What a package may carry

| Allowed | Types |
|---|---|
| Pictures | `png` `jpg`/`jpeg` `gif` `webp` `avif` `svg` `ico` |
| Fonts | `woff` `woff2` `ttf` `otf` `eot` |
| Text | `css` `txt` `json` |

Anything else is refused by name. A `.html` or a `.js` in a package is not styling — it is a second,
unmanaged site living under the theme's URL.

Refused, with the reason: paths that escape the package (`../x`), absolute paths, symlinks, encrypted
members, zip64 archives, AppleDouble bookkeeping (`__MACOSX/`, `._*`), a member over 8 MiB, a package
over 32 MiB expanded or 400 files, and any member whose CRC does not match.

### Limits

| | |
|---|---|
| The sheet | 512 KiB |
| The archive | 16 MiB |
| One asset | 8 MiB |
| All assets | 32 MiB |

## Where the bytes live

```
data/tenants/<tenant>/theme-assets/<theme-key>/<path>
```

beside the tenant's `site.db`, not in `content/`. `cms_theme_asset` holds one row per file
(`path`, `sha256`, `bytes`, `content_type`) and is the link the renderer follows: a request for
`/_theme/<key>/<path>` is answered only when a row names that path, so a URL can never reach a file
the database does not say exists. Deleting a theme deletes its rows and its directory; the
stylesheet blob stays, because another theme or a page may share those exact bytes.

## Uploading from the command line, against a running box

```sh
# the Themes screen is a normal form post: csrf + a .css file (or a .zip package)
curl -sS -b "cookies.txt" -H "Origin: https://<tenant-host>" \
  -F csrf=<token from /admin/t/<key>/themes> \
  -F name="Midnight Kiln" -F theme=@themes/midnight-kiln.css \
  https://<tenant-host>/admin/t/<key>/themes/upload
```

A stylesheet is refused (403 `SKW_E_PL_REJECTED`) when it is empty, larger than 512 KiB, contains
`<script`, or contains `</style`. Neither of the last two is executable as `text/css`; both are
symptoms of a file that is not a stylesheet. A package is refused the same way for any reason in the
list above, and the screen says which one it was.

## Building a package

```sh
mkdir -p /tmp/kiln/assets
cp themes/midnight-kiln.css /tmp/kiln/theme.css
printf '{"name":"Midnight Kiln"}\n' > /tmp/kiln/theme.json
cp /path/to/a/logo.svg /tmp/kiln/assets/logo.svg
printf '\n.site-header__mark{background:url(assets/logo.svg) no-repeat center/contain}\n' >> /tmp/kiln/theme.css
(cd /tmp/kiln && zip -qr ../kiln.zip theme.css theme.json assets)
```

Upload `kiln.zip` on **Themes**. The list shows the file count and total size beside the sheet, so a
package is visibly a package; **Preview** opens the real site wearing it for fifteen minutes without
activating anything.
