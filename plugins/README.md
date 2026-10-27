# Plugin packages

A package is a directory with `plugin.json`, an ESM entry point, and — when it is packed — a
`test-report.json` beside it. Three states, and they belong to different things:

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
  --out data/plugin-library/contact-1.1.0.tar.gz
```

The report must be bound to the package's **own root hash**, and it must sit beside the package in
the archive rather than inside it — a file inside the root changes the hash the report attests,
which is why `pack` puts it there and why `unpackArchive` refuses an archive that has one inside.

Every tenant then sees `contact-1.1.0.tar.gz` under **Available on this box** until it installs it
for itself. The library is a directory, not a database: adding an archive is `cp`, removing one
removes it from the shelf for tenants that have not installed it (installed copies are unaffected).

## Signature and test reports

- Unsigned packages are legal only with the operator's explicit acknowledgement on the install form
  (`allow_unsigned`), and the installed row records `signature_state = unsigned`.
- A missing, stale or mismatched test report is `SKW_E_PL_TESTS_STALE`: a package cannot ship
  untested and be discovered by a client's contact form.
- A revoked root cannot be installed or enabled whatever the archive says about itself.

## Shipped packages

| Package | Table | Screen | Public endpoint |
|---|---|---|---|
| `blog` | `p_blog_post` | “Blog posts” | `GET /_plugin/blog/posts` |
| `contact` | `p_contact_message` | “Messages” | `POST /_plugin/contact/submit` |
| `menu` | `p_menu_item` | menus | `GET /_plugin/menu/items` |

`plugins/` holds the sources; `data/plugin-library/` holds the archives. The zip/tar artefacts are
build output and are gitignored.
