# Themes

Stylesheets a site can be given from **Admin → Themes → Upload a theme**. Each one is a complete
`site.theme_css`: it styles the shell the host draws (`.site-header`, `.site-menu`, `.site-footer`)
and the `s-*` vocabulary the pages carry. Uploading stores the file once, keyed by its hash; exactly
one theme is active at a time (`site.theme_key`), and a theme can be previewed on the real page
before it is activated.

| file | ground | accent | notes |
|---|---|---|---|
| `midnight-kiln.css` | `#0c0d10` ink | `#ff7a4d` ember | Dark editorial. Paper-cream text, hairline rules, cards instead of boxes, one soft glow at the top of the page. Contrast measured: 16.13:1 body, 8.99:1 muted, 7.54:1 accent. |

Uploading from the command line, against a running box:

```sh
# the Themes screen is a normal form post: csrf + a .css file
curl -sS -b "cookies.txt" -H "Origin: https://<tenant-host>" \
  -F csrf=<token from /admin/t/<key>/themes> \
  -F name="Midnight Kiln" -F theme=@themes/midnight-kiln.css \
  https://<tenant-host>/admin/t/<key>/themes/upload
```

A theme is refused (403 `SKW_E_PL_REJECTED`) when it is empty, larger than 512 KiB, contains
`<script`, or contains `</style`. Neither of the last two is executable as `text/css`; both are
symptoms of a file that is not a stylesheet.
