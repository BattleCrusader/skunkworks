# Plugin packages

A package is a directory with `plugin.json`, an ESM entry point, optionally the client scripts it
declares in `files[]` (served same-origin at `GET /_plugin/<id>/f/<name>`), and — when it is packed —
a `test-report.json` beside it. Three states, and they belong to different things:

| State | Lives in | Belongs to |
|---|---|---|
| **In the library** | `data/plugin-library/<id>-<version>.tar.gz` | the box — every tenant sees every entry |
| **Installed** | `cms_plugin_installed` + the package's `p_*` tables in **that tenant's** `site.db` | one tenant |
| **Enabled** | `cms_plugin_installed.enabled` | one tenant |

A package in the library is not installed anywhere. Installing it from
`/admin/t/<tenant>/plugins` creates its tables in that tenant's database and nowhere else: two
tenants installing the same package get two copies of the schema and two sets of rows, and neither
can read the other's. Installing does not enable — Enable is a separate press.

## Putting a package on the shelf

```sh
skwctl plugin pack plugins/contact --report test-reports/contact.json \
  --out data/plugin-library/contact-1.2.0.tar.gz
```

The report must be bound to the package's **own root hash**, and it must sit beside the package in
the archive rather than inside it — a file inside the root changes the hash the report attests,
which is why `pack` puts it there and why `unpackArchive` refuses an archive that has one inside.

Every tenant then sees `contact-1.2.0.tar.gz` under **Available on this box** until it installs it
for itself. The library is a directory, not a database: adding an archive is `cp`, removing one
removes it from the shelf for tenants that have not installed it (installed copies are unaffected).

## Signature and test reports

- Unsigned packages are legal only with the operator's explicit acknowledgement on the install form
  (`allow_unsigned`), and the installed row records `signature_state = unsigned`.
- A missing, stale or mismatched test report is `SKW_E_PL_TESTS_STALE`: a package cannot ship
  untested and be discovered by a client's contact form.
- A revoked root cannot be installed or enabled whatever the archive says about itself.

## Shipped packages

| Package | Version | Table | Screen | Public endpoint |
|---|---|---|---|---|
| `blog` | 1.1.0 | `p_blog_post` | “Blog posts” | `GET /_plugin/blog/posts` |
| `contact` | 1.2.0 | `p_contact_message` | “Messages” | `POST /_plugin/contact/submit` |
| `menu` | 1.0.0 | `p_menu_item` | menus | `GET /_plugin/menu/items` |
| `analytics` | 1.0.3 | `p_analytics_event` | “Analytics events” | `POST /_plugin/analytics/collect` · `GET /_plugin/analytics/f/t.js` |

`analytics` 1.0.3 is the first package to declare `files[]`, and it is the reason the field exists.
A page's CSP is `script-src 'self'` with no nonce (§10.5, C-12), so the only way a package can run
code in a visitor's browser is a `<script src>` on the tenant's own origin — served by the host from
the package's own root at `/_plugin/<id>/f/<name>`, `text/javascript` only, realpath-contained, and
404 for anything the manifest did not declare. The package's `page.head` hook writes the tag; the
dashboard is the host's own Analytics screen (`/admin/t/<key>/analytics`), which reads the table and
draws no plugin markup. The tracker itself sets no cookie and stores no address — see
`docs/privacy/pii-australia.md` §5.

`contact` 1.2.0 adds the optional `company` column: a firm's enquiry form keeps the name of the firm
it came from instead of folding it into the message. A form the host draws can be given the page's
own words — `data-skw-label-<field>`, `data-skw-submit`, `data-skw-thanks` on the marker — because
the package owns the fields and the page owns the copy.

`plugins/` holds the sources; `data/plugin-library/` holds the archives. The zip/tar artefacts are
build output and are gitignored.
