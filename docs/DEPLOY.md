# Deploying Skunkworks — best practice for a Docker host

**Status:** written 2026-11-03 against `main` @ `f7984cb`, 975 tests green, verified on the live
`dev-fractionalworks.com.au` box. Every command and path below is taken from the code
(`install.sh`, `docker-compose.yml`, `app/cli/skwctl.ts`, `tools/acme.mjs`) or measured on that box.
Nothing here is aspirational; the gaps are named in §11 rather than buried.

**Audience:** whoever is holding the SSH key when a VPS comes up, and the next person who has to
take over.

---

## 0. The shape, before the commands

Three containers, one host:

```
        :80 :443                        (no published port)
  ┌──────────────┐     proxy_pass     ┌──────────────────┐
  │    nginx     │ ─────────────────► │       app        │
  │  edge, TLS   │   app:3000         │  Fastify + SSR   │
  └──────┬───────┘                    └────────┬─────────┘
         │ read-only mounts                    │ read-write
         │ ./nginx/conf.d, ./snippets        │ ./data  ./content
         │ ./content, ./data/certs           │
         │ ./data/acme, ./data/nginx/…        │
         │                                    │
  ┌──────┴───────────────┐                   │
  │        acme          │  reads ./data/control.db
  │ RFC 8555 + reloads   │  writes ./data/certs, ./data/acme
  │ nginx over the socket│  HUP nginx on new cert *and* on config change
  └──────────────────────┘
```

**Why nginx is its own container — not merged into the app.** This is the decision people get
wrong once per project, so it is stated as a rule:

1. **The app must not hold a privileged port.** `Dockerfile.app` ends `USER 10001:10001`; compose
   runs it `read_only: true`, `tmpfs: /tmp`, `no-new-privileges:true`, `expose: 3000`. Merging the
   edge would require either `CAP_NET_BIND_SERVICE` or root — the exact privileges the image
   deliberately does not have. A page renderer with root is a worse trade than a second container.
2. **One listener, many hostnames.** The generated edge config holds one `listen 443 ssl` block per
   host — 10 `server_name` directives across 5 names on the current box. Containers cannot share a
   host port; per-site containers each binding :443 would need one IP per site. One edge, N tenants
   is the whole fleet model.
3. **Certificates and config must reload without touching the app.** The `acme` service replaces
   pairs and HUPs **nginx**. If nginx were PID 1 of the app container, every renewal would signal
   the app — dropping in-flight requests and SQLite handles.
4. **Different clocks.** The app ships weekly; the edge image is pinned (`nginx:1.31-alpine`) and
   should outlive many app deploys. Coupling them means a CSS feature redeploys your TLS terminator.
5. **The config is data, not image.** `10-app.conf` is generated from `control.db` into
   `data/nginx/10-app.conf` and bind-mounted read-only. That is what makes "verify the bundle, run
   the bundle" possible, and what lets the CMS add a tenant without a rebuild.

Measured cost of the split on this box: `nginx` **8.0 MiB RSS**, `app` 98.1 MiB, `acme` 14.9 MiB,
one loopback hop. That is the entire price.

**The exception, stated so nobody cargo-cults this:** a single-site, single-domain appliance with
no fleet routing could collapse the edge into the app. Even then two containers stay simpler to
renew certificates in. Do not collapse it "to save memory" — you save 8 MiB and lose all five points
above.

---

## 1. Provisioning the VPS

| Requirement | Why / how |
|---|---|
| Docker Engine **24+** with the compose v2 plugin | `docker compose`, not `docker-compose` |
| Ports **80** and **443** published by nginx | 80 is not optional: ACME http-01 answers on it |
| **443 open, 3000 closed** | the app publishes no port; `expose:` only |
| An A (and AAAA if you have v6) record per host | `install.sh --domain` refuses with **exit 11** if it does not resolve — deliberately, before nginx can crash-loop on a missing cert |
| Node **≥ 22.5** on the host for `install.sh` / `skwctl` | only for `node:sqlite`; no compiler, no `sqlite3` binary needed |
| ~2 GiB RAM, 10 GiB disk | the app is ~100 MiB resident; SQLite databases are small; media is the growth term |
| Time sync | `chrony`/`systemd-timesyncd` must be on: TOTP and audit sealing both assume a correct clock |

Host firewall, the short version:

```bash
# ufw
ufw default deny incoming && ufw allow 22/tcp && ufw allow 80,443/tcp && ufw enable
# or nftables/cloud security group — the rule is: 22, 80, 443 in. Nothing else.
```

Do **not** proxy the app's port to the internet "for debugging" — the admin surface answers on the
tenant's own host and expects to be behind the edge's allowlist (§7).

---

## 2. First deploy — the five-minute path

```bash
# 1. get the bundle onto the box and verify it before running anything
scp skunkworks-site-bundle.zip root@vps:/srv/ && ssh root@vps
cd /srv && unzip -q skunkworks-site-bundle.zip -d app && cd app
node tools/bundle_verify.mjs .        # hashes, symlinks, plugin rows; refuses a dirty tree

# 2. images (a released bundle pins real digests; this tree's compose still carries the
#    all-zero placeholders, so build locally — see §11 gap 1)
docker build -f Dockerfile.app -t skw-app:local .
docker build -f acme/Dockerfile  -t skw-acme:local .

# 3. install: control.db → seed → tenant db → .env → certs → edge config → compose up
ACME_EMAIL=you@example.com \
SKW_APP_IMAGE=skw-app:local SKW_ACME_IMAGE=skw-acme:local \
./install.sh --target ./data --bundle . --runtime . \
             --email you@example.com --domain client.example.com --verify-login
```

`install.sh` exit codes are the contract, not diagnostics to skim:

| Code | Meaning |
|---|---|
| 0 | installed, or already bootstrapped (bootstrap exit 3 is benign) |
| 11 | the A record for `--domain` does not point at this box |
| 12 | bundle verification failed (sha, symlink, plugin row without its package, seed/schema mismatch) |
| 15 | `control.db` could not be created, migrated or seeded |
| 16 | `skwctl admin bootstrap` failed for a reason other than "already bootstrapped" |
| 17 | `docker compose up` failed |
| 18 | host node cannot run the install tools (needs ≥ 22.5) |
| 19 | no app runtime carrying `skwctl` (`--runtime` or the pinned image) |

What it leaves behind, and what each part is for:

```
data/control.db              tenants, domains, users, sessions, audit, edge state
data/tenants/<key>/site.db   one SQLite database per site — pages, assets, theme rows, plugins
data/themes/<key>/           box-level theme library (importable into any tenant)
data/certs/                  per-host pairs: self-signed at install, ACME-replaced later
data/acme/                   http-01 webroot nginx serves
data/nginx/10-app.conf       THE edge config — generated from control.db, mounted into nginx
data/enrol-<key>.txt         the admin credential of record (0600)
content/                     media blobs + protected/ stamped downloads
```

**One rule about that config:** `data/nginx/10-app.conf` is generated, never hand-edited, and never
committed. The file tracked in git (`nginx/conf.d/10-app.conf`) is a **test fixture** naming
`acme.test`/`beta.test`; compose bind-mounts the generated file over it, so a live box never runs the
fixture — and `git status` on a deployed tree stays clean.

---

## 3. Adding a site after install

Two doors, same result:

```bash
# CLI, on the box
node dist/app/cli/skwctl.js site import /srv/bundles/client2.zip \
     --tenant client2 --host client2.example.com --primary client2.example.com --nginx

# or the portal: /fleet/import — file chooser, tenant key, hosts, optional wildcard
# (fleet-scoped: only a box-level operator may create a tenant)
```

Both write the tenant's rows, its `site.db`, its media and theme files, **then regenerate
`data/nginx/10-app.conf`**. Nothing is live until nginx re-reads that file, and this is the part that
used to be silently broken:

> The CMS cannot signal nginx — it has no Docker socket and should not be given one, because a
> compromised renderer with `/var/run/docker.sock` is root on the host. So the file is the signal:
> the `acme` service stats `<data>/nginx/10-app.conf` every `SKW_ACME_WATCH_S` seconds (default 10),
> and on a changed mtime sends nginx a `HUP` over the socket it already holds for certificates.
> A new tenant is reachable within ~10 s of import, with no manual step and no second trust boundary.

Verification, the only one that counts:

```bash
curl -sI https://client2.example.com/ | head -1          # 200, not 404
docker logs --tail 5 skunkworks-acme-1                   # "edge config changed; nginx reloaded"
docker exec skunkworks-nginx-1 nginx -t                  # config parses
```

If a generated block is malformed, nginx refuses the *reload* and keeps the old workers serving:
you lose the new site, never the fleet. The acme log says `nginx was not reloaded (see above)`.

---

## 4. Certificates

1. **Install time:** a per-host self-signed pair, so HTTPS answers immediately and nothing crash-loops
   waiting for a CA. `domain.cert_state` is `none` or `pending` — never `issued` for a cert it did not get.
2. **Then ACME:** `acme` speaks RFC 8555 (JWS/ES256, order/authz/finalize, DER CSR built in-process
   because the image carries no openssl), answers http-01 from `data/acme/`, writes
   `data/certs/<host>.crt|key`, flips `cert_state` to `issued`, and HUPs nginx.
3. **Renewal is age-based** — `SKW_ACME_RENEW_DAYS` (default 60 of 90). The image cannot parse
   `notAfter` (no openssl), and scheduling early beats pretending to read an expiry.
4. **Production CA is unproven.** Proven against Pebble with validation not short-circuited; never
   against Let's Encrypt from this box. Do the first issuance on a throwaway host and watch
   `cert_state` go `pending → issued`.

```bash
sqlite3 data/control.db "select host, cert_state from domain"   # or the health endpoint
```

---

## 5. Upgrades and rollback

The app image is pinned by **digest** in a released bundle — a tag can move, a digest cannot.

```bash
# upgrade
docker compose pull app            # or: docker build -f Dockerfile.app -t skw-app:local .
docker compose up -d --no-deps app # nginx and acme untouched
curl -sf http://127.0.0.1:3000/healthz   # inside the network; see §9 for a host-side check

# rollback — the previous digest is the rollback
SKW_APP_IMAGE=ghcr.io/skunkworks/app@sha256:<previous> docker compose up -d --no-deps app
```

Migrations run on boot, forward only. **Before any upgrade, take the backup in §6** — a rollback of
the image does not roll back a migrated database.

---

## 6. Backup and restore

Back up **`data/`** and **`content/`**. That is the whole state: tenants, domains, users, sessions,
audit chain, themes, certificates, media, and the generated edge config. Do not back up containers,
images, or `node_modules`.

```bash
# consistent copy: SQLite in WAL mode — VACUUM INTO, not cp
sqlite3 data/control.db "VACUUM INTO '/srv/backup/control.db'"
for db in data/tenants/*/site.db; do
  sqlite3 "$db" "VACUUM INTO '/srv/backup/$(basename "$(dirname "$db")").db'"
done
tar -C /srv -czf /srv/backup/content-$(date +%F).tgz content data/certs data/themes data/nginx
```

Restore: stop the stack, put `data/` and `content/` back, `docker compose up -d`, then
`skwctl audit verify --chain --tenant <key>` — an audit chain that does not verify means the restore
is not the database you think it is.

Export a site as a portable bundle any time from the portal (`Site → Take this site somewhere else`)
or `skw-export --archive`; a theme alone from `Themes`. Both are deterministic (same input → same
sha256), so a bundle is a receipt as well as a backup.

---

## 7. Security posture — do not weaken these to make something work

| Control | Where | What it buys |
|---|---|---|
| app is non-root `10001` | `Dockerfile.app`, compose | a container escape starts unprivileged |
| `read_only: true` + `tmpfs: /tmp` | compose | nothing persists in the image layer; no droppable webshell |
| `no-new-privileges:true` | compose | setuid binaries inside the image are inert |
| app publishes **no** port | compose `expose:` | the only path in is the edge |
| admin allowlist | `SKW_ADMIN_ALLOWLIST` (edge emits allow/deny, app enforces TOTP) | the admin surface is not world-open even if a password leaks |
| docker socket in **acme only** | compose | one small service holds it; the renderer never does |
| origin + CSRF on every write (D28) | app | a cross-site form cannot mutate a site |
| audit chain per tenant | `skwctl audit` | tampering is detectable, not just discouraged |

The credential of record is `data/enrol-<key>.txt` (0600): password + TOTP secret.
`admin reset-password` does **not** rotate TOTP, and its enrolment file omits the unchanged secret —
regenerate the full enrolment file rather than handing out half a credential.

---

## 8. Routine operations

```bash
node dist/app/cli/skwctl.js audit status --tenant <key> --days 30   # exit 1 = a day is unsealed
node dist/app/cli/skwctl.js audit seal --heal --tenant <key>        # backfill gaps
node dist/app/cli/skwctl.js audit verify --chain --tenant <key>
docker compose ps                                                 # app healthy, nginx/acme up
docker logs --since 15m skunkworks-acme-1 | tail -20               # issuance + edge reloads
```

Health endpoint: `GET /healthz` on the app (internal), reports DB reachability and unsealed audit
days over a 400-day window. The compose healthcheck calls it every 30 s.

Disk: watch `content/` (media) and `data/tenants/*` growth. SQLite in WAL mode means a `-wal` file
next to each database while it is open — expected, not evidence of a leak.

---

## 9. Troubleshooting, by symptom

| Symptom | Most likely cause | Check / fix |
|---|---|---|
| `502` from nginx | app container down or crashing | `docker compose ps`, `docker logs skunkworks-app-1` |
| Site returns `404` for a host that resolves here | no `server_name` block, or nginx has not reloaded | `grep -c server_name data/nginx/10-app.conf`; `docker exec skunkworks-nginx-1 nginx -t`; `docker logs skunkworks-acme-1` for `edge config changed` |
| `400 SKW_E_SEC_AUTH_INVALID` on `/admin/login` | wrong password **or** a stale credential after a reset | audit rows say `reason:"password"`; reset with `skwctl admin reset-password` and use the new enrolment file |
| `400` on any admin write | missing `Origin`/CSRF (a raw `curl` is not a browser) | send `Origin: https://<host>` and the session's CSRF field/token |
| Cert stays `pending` | 80 blocked, A record wrong, or CA unreachable | `curl -sI http://<host>/.well-known/acme-challenge/x`; `docker logs skunkworks-acme-1` |
| `compose up` fails at nginx | config names a cert that does not exist (usually the tracked fixture on a real install) | regenerate: `skwctl site import … --nginx` or rerun `install.sh` with the same `--target` |
| `install.sh` exit 11 | DNS not pointed yet | wait for propagation, or `--skip-dns` only when you know why |
| `install.sh` exit 12 | bundle was modified in transit | re-copy; never `--force` past a hash mismatch |

---

## 10. Anti-patterns (each one is a bug I have already seen)

- **nginx inside the app container.** Privilege downgrade, one host per IP, cert renewals that
  restart your renderer. §0.
- **Giving the app `/var/run/docker.sock`** so it can reload nginx. That socket is root. The file
  mtime plus the acme watcher is the same feature with none of the exposure.
- **Editing `data/nginx/10-app.conf` by hand.** It is regenerated from `control.db` on the next
  import or install; your edit disappears and you will not be told.
- **Committing `nginx/conf.d/10-app.conf` from a live box.** It carries your clients' hostnames.
- **Running the app as root "because ports".** nginx exists so you never have to.
- **`docker compose down -v` to "clean up".** `-v` removes the volumes you mounted data into.
- **Restoring a backup without verifying the audit chain.** A database that opens is not a database
  that is intact.

---

## 11. Known gaps — do not promise these to a client

| Gap | Consequence |
|---|---|
| **Registry pull is impossible as shipped** | The compose digests are all-zero placeholders; `docker compose pull` cannot work until a release publishes real ones. Build locally and override `SKW_APP_IMAGE` / `SKW_ACME_IMAGE`. |
| **ACME against a production CA is unproven** | Proven against Pebble only; do the first issuance on a throwaway host. |
| **A synchronous plugin hang cannot be timed out** | Plugins run in-process (WordPress model); a hung plugin stalls that request until it finishes. |
| **Renewal is age-based, not expiry-based** | 60/90 days by default; the image cannot read `notAfter`. |
| **`§16 row 12` unmeasured** | "Clean host install ≤ 5 min with images present" has not been run under that condition. |
| **Pebble `badNonce` flake** | Seen once under a 3× loaded box; the simulator's wall-clock, not the client. Re-run before believing a TLS test failure. |

---

## 12. First client checklist

- [ ] `bundle_verify` clean, images built, `compose up`, HTTPS 200 with the self-signed pair
- [ ] `install.sh --verify-login` reached the tenant's first page over the real listener
- [ ] Real issuance on a throwaway host: `cert_state` `pending → issued`, nginx reloaded
- [ ] `skwctl admin bootstrap`, TOTP scanned, admin login works at `https://<tenant host>/admin/login`
- [ ] A page authored in the editor; save twice → byte-identical
- [ ] One public asset, one gated; `/media/<gated-key>` is a 404
- [ ] Import a second site; its host answers 200 within ~10 s and `acme` logs the reload
- [ ] `audit status` exits 0 the morning after the first midnight
- [ ] Backup taken with `VACUUM INTO`; `bundle_verify` clean; restore rehearsed once
