# Deploying Skunkworks — operator runbook

**Status of this document:** written 2026-10-21 against `main` @ `91312d7`, 616 tests green. Every command below is taken from the code (`install.sh --help` block, `app/cli/skwctl.ts`) — nothing here is aspirational.

**What you are deploying:** three containers — `nginx`, `app`, `acme` — one SQLite database per tenant under `data/`, plus `control.db` for tenants, domains, users and sessions. Plugins run **in-process** inside `app` (WordPress-style), so there are no extra services.

---

## 0. Before you start

| Need | Detail |
|---|---|
| Docker | Engine + compose v2 on the target host |
| A domain | DNS A record pointing at the box **before** install if you pass `--domain` (install refuses with exit 11 if it does not resolve — that check is deliberate) |
| Node runtime for `skwctl` | `--runtime DIR` pointing at a tree with `dist/` + `node_modules`, or the pinned image |
| Ports | 80 and 443 published by nginx; **the app publishes no port** |

---

## 1. Build the images locally (registry pull is not proven yet)

The compose file references pinned `ghcr` digests that have **never been pulled from a registry**. Build and tag locally:

```bash
docker build -f Dockerfile.app -t skw-app:local .
docker build -f acme/Dockerfile  -t skw-acme:local .
SKW_APP_IMAGE=skw-app:local SKW_ACME_IMAGE=skw-acme:local docker compose up -d
```

Compose references `ghcr.io/skunkworks/app@sha256:0000…` and `ghcr.io/skunkworks/acme@sha256:0000…` — **placeholder all-zero digests**, so a pull cannot succeed by design until a release publishes real ones. The two `SKW_*_IMAGE` variables are the supported override and are what the gates use. There is no `runner` image: D36 deleted that service (see §9).

---

## 2. Install into a target directory

```bash
./install.sh --target ./data --bundle . --runtime . --admin-host admin.example.com \
             --email you@example.com --domain client.example.com
```

Useful flags:

| Flag | Meaning |
|---|---|
| `--target DIR` | install root (default `./data`) |
| `--bundle DIR` | bundle root; `BUNDLE.json` is verified if present |
| `--seed FILE` | `data/control.seed.json` inside a bundle, or your own |
| `--admin-host HOST` | admin hostname (default `admin.skw.test`) |
| `--no-compose` | stop after bootstrap — **use this to inspect before going live** |
| `--verify-login` | boot the app in-process and log in end to end |
| `--skip-dns` | skip the DNS check even with `--domain` |

The installer runs **9 gates**, migrates `control.db` to schema **v4**, seeds the tenant and installs its `site.db`, writes the enrolment file `0600` with `O_EXCL`, mints a **per-host self-signed certificate** into `data/certs/`, and **generates `nginx/conf.d/10-app.conf` from the control.db it just seeded**.

That last step matters more than it looks. The file tracked in git is a **test fixture** (it names `acme.test`, `beta.test`, `broken.test`, `acme-demo.test`, `demos.skw.test`), because `tools/regen_conf.ts` rewrites it from the gate's fixtures. Shipping it to a real install is a dead site: nginx loads it, asks for `/etc/nginx/certs/acme.test.crt`, and crash-loops — measured on a seed with `abc123.com` / `demo.abc123.com` / `123abc.com`, with every gate green because every gate used the fixture hosts. `install.sh` now generates it, and `test/nginx-config.test.ts` NG-8 fails if that call is removed. `cert_state` is written as `none` or `pending` until a certificate actually exists — the installer will not claim `issued` for a certificate it did not obtain.

**Measured:** 1.2 s machine + ~20 s human (one TOTP scan) = **21.2 s of the documented 300 s promise**, clean directory to `GET /` 200. Second run is idempotent (0.17 s).

---

## 3. Certificates

On install you get a **self-signed pair per host** so the site serves HTTPS immediately. The `acme` service then performs a real RFC 8555 issuance, writes the pair, sets `cert_state = issued`, and HUP-reloads nginx (no restart).

- Proven against **local Pebble**, with validation not short-circuited.
- **Not yet proven against a production CA.** Do your first real issuance on a throwaway subdomain and watch `control.db` (`domain.cert_state`) go `none → issued`.

---

## 4. First admin login

```bash
node dist/app/cli/skwctl.js admin bootstrap --email you@example.com --enrolment-out ./admin-enrol.txt
```

- Claims the seed in one transaction; exit **3** on a second run (the only benign refusal).
- Prints a **24-character password** and a **20-byte base32 TOTP secret** in a `0600` file.
- Scan the TOTP secret with your authenticator, then log in at `https://admin.example.com/admin/login`.

Recovery, when you need it:

```bash
node dist/app/cli/skwctl.js admin reset-password --email you@example.com
node dist/app/cli/skwctl.js admin reset-totp     --email you@example.com --enrolment-out ./new-enrol.txt
```

---

## 5. A client site

1. The tenant, its domain and its pages come from the **seed** (`data/control.seed.json`) — there is no `tenant create` verb; a new client is a **bundle cut from this tree** with its own seed. That is the deployment model: one bundle per client.
2. Author pages in the admin editor at `/admin/t/<key>/editor`. Drag components from the palette; save; the editor's fixpoint means a second save is byte-identical to the first.
3. Assets: upload in the media library. Content stores the **key**; the URL is derived at render (`/media/<key>.<ext>?v=<sha8>`). Gated assets get **no** public link — `/media/<gated-key>` is a 404 byte-identical to a missing key.
4. Navigation renders from `cms_nav` (header/footer/sidebar, position order, two levels). A nav entry pointing at a missing page, a draft, a gated asset or a `javascript:` URL is **refused by name**, not rendered as a dead link.

---

## 6. Paid downloads

1. Upload the asset, set `access_class = gated` or `protected`, and pick a watermark asset if the file is a PDF or image.
2. Issue codes: 16 Crockford characters (4 selector + 12 secret), argon2id on the full code, no pepper. `max_uses` resolves per issue → tenant default.
3. The buyer redeems at `POST /d/<key>`, gets a cookie, and downloads once: **8 parallel Range requests spend one use**, proven over HTTP, over 8 separate OS processes, and through real nginx.
4. Every stamped file is per-purchaser, served from `content/protected/` and never the shared blob. A stamp failure or a 2 s budget overrun returns **503** with no download header — it never serves an unstamped file.

---

## 7. Plugins

```bash
# trust a publisher first — this is what makes an install attributable
node dist/app/cli/skwctl.js plugin trust import publisher.pem --publisher acme-labs
node dist/app/cli/skwctl.js plugin trust list

node dist/app/cli/skwctl.js plugin install ./my-plugin --tenant client1
node dist/app/cli/skwctl.js plugin enable  my-plugin --tenant client1
node dist/app/cli/skwctl.js plugin disable my-plugin --tenant client1
node dist/app/cli/skwctl.js plugin revoke  my-plugin --tenant client1
node dist/app/cli/skwctl.js plugin uninstall my-plugin --tenant client1
```

**Read this before installing anything third-party.** The install screen says it, and so does the spec:

> Capabilities describe what this plugin **asks the CMS for**. They do not limit what its code can do: **a plugin runs inside the site's process, with the site's own access to its files and databases.**

A signature buys **author identity and tamper detection — not containment**. Unsigned installs are refused unless you pass `--allow-unsigned`, which is loud and recorded in the audit row.

---

## 8. Operations

```bash
node dist/app/cli/skwctl.js audit status  --tenant client1 --days 30   # exit 1 if a day is unsealed
node dist/app/cli/skwctl.js audit seal    --tenant client1 --day 2026-10-20
node dist/app/cli/skwctl.js audit seal --heal --tenant client1         # backfill gaps
node dist/app/cli/skwctl.js audit verify --chain --tenant client1
```

- The audit chain is **per-segment**; a missed midnight surfaces in `audit status` (exit 1) and clears on `--heal`.
- The health endpoint reports unsealed days over a **400-day** window.
- Backups: `data/` holds every tenant database and the media store. A bundle is verifiable with `tools/bundle_verify.mjs`, which **refuses** a bundle containing `content/protected/` or a live watermark render.

---

## 9. Known gaps — do not promise these to a client

| Gap | Consequence |
|---|---|
| **Registry pull impossible as shipped** | The compose digests are **placeholder all-zeros**; `docker compose pull` cannot work until a release publishes real ones. Build locally and override `SKW_APP_IMAGE` / `SKW_ACME_IMAGE`. |
| **ACME against a real CA unproven** | Works against Pebble; do a first issuance on a throwaway host |
| **Exports carry no navigation** | Served sites have a menu; **exported** trees do not (§11.1 says they should) |
| **The plugin runner no longer exists** | D36 replaced it with in-process loading — any `runner/` reference in an old compose file is dead |
| **A synchronous plugin hang cannot be timed out** | Accepted cost of the WordPress model. The site stalls until the request finishes |
| **§16 row 12 unmeasured** | "Clean host install ≤ 5 min with images present" has never been run under that condition |
| **Pebble `badNonce` flake** | Seen once in several test runs; the ACME simulator's problem, not ours |
| **`nginx/conf.d/10-app.conf` is tracked** | A live install overwrites it, so `git status` shows it modified on a deployed box. **Never commit that file from a running install** — it carries your client's hostnames |

---

## 10. First client checklist

- [ ] Build images locally, `compose up`, HTTPS 200 with a self-signed cert
- [ ] Real issuance on a throwaway host; `cert_state` reaches `issued`
- [ ] `skwctl admin bootstrap`, TOTP scanned, login works
- [ ] Tenant seeded, one page authored in the editor, save twice → byte-identical
- [ ] One asset public, one gated; `/media/<gated-key>` is a 404
- [ ] One download code issued and redeemed; `cms_download_event` has exactly one `first` row
- [ ] `audit status` exits 0 the morning after the first midnight
- [ ] Backup taken, `bundle_verify` clean
