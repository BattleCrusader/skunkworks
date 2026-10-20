#!/usr/bin/env bash
# install.sh — verify → control.sql → seed → tenant database → .env → bootstrap → compose up
#              (SDS §11.6, errata E-19, D30)
#
# Exit codes, and what each one means to whoever runs this:
#
#   0   installed, or already bootstrapped (bootstrap exit 3 is benign: nothing changed)
#   11  the A record for --domain does not point at this box (0.3 s, §11.6)
#   12  bundle verification failed — a sha256, a symlink target, a plugin row without its
#       package, or a seed whose schema_version disagrees with control.sql
#   15  control.db could not be created, migrated or seeded
#   16  `skwctl admin bootstrap` failed for a reason other than "already bootstrapped"
#   17  `docker compose up` failed  (an addition: §11.6 names no code for it)
#   18  this host's node cannot run the install tools (needs node >= 22.5 for node:sqlite)
#   19  no app runtime: neither ./dist nor a --runtime directory carries `skwctl`
#
# `--no-compose` stops after bootstrap, which is what the S2b and S4c gates measure: the
# released image digest is S4's artefact and does not exist locally, so a compose step
# here would test the registry rather than this slice.
#
# `--verify-login` boots the installed app in-process, logs in with the password and
# the TOTP secret from the enrolment file, fetches GET /admin **and fetches the tenant's
# first published page over the real listener**. That last fetch is what makes D30's
# five-minute promise ("an empty host directory to a served page") something the install
# itself proves, rather than something a report measures once.
#
# Two dependencies, both deliberate:
#
#   - **node**, and nothing else. `schema/control.sql`, the seed and the verification all
#     run through `node:sqlite` (tools/*.mjs), so the install works on a server with no
#     `sqlite3` binary and no compiler. The previous version shelled out to `sqlite3` and
#     required `better-sqlite3` from a tree the bundle does not carry.
#   - **an app runtime** for `skwctl`, which is the one step that needs the image's own
#     modules (argon2 + better-sqlite3). In a source tree that is `./dist`; in a bundle it
#     is `--runtime DIR` (the tree that cut the bundle) or, in production, the pinned
#     image via `docker compose run`.
set -euo pipefail

TARGET="data"
BUNDLE="."
SEED=""
RUNTIME=""
ADMIN_HOST=""
EMAIL=""
DOMAIN=""
COMPOSE=1
VERIFY_LOGIN=0
SKIP_DNS=0
FORCE=0

usage() {
  cat <<'EOF'
usage: ./install.sh [options]

  --target DIR        install into DIR (default: ./data)
  --bundle DIR        bundle root (default: .) — BUNDLE.json is verified if present
  --seed FILE         seed file (default: data/control.seed.json in a bundle,
                      schema/control.seed.json in a source tree)
  --runtime DIR       a tree with dist/ + node_modules for `skwctl` (default: this root,
                      then SKW_RUNTIME_DIR, then `docker compose run app`)
  --admin-host HOST   the admin hostname (default: admin.skw.test)
  --email ADDRESS     the ACME contact address (default: admin@<admin host>)
  --domain DOMAIN     the tenant's domain; enables the DNS check (exit 11)
  --skip-dns          do not check DNS even when --domain is given
  --no-compose        stop after bootstrap; do not run `docker compose up -d`
  --verify-login      after install, log in and fetch GET /admin and the tenant's page
  --force             re-run the DDL/seed steps on an existing data directory
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --bundle) BUNDLE="$2"; shift 2 ;;
    --seed) SEED="$2"; shift 2 ;;
    --runtime) RUNTIME="$2"; shift 2 ;;
    --admin-host) ADMIN_HOST="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --no-compose) COMPOSE=0; shift ;;
    --verify-login) VERIFY_LOGIN=1; shift ;;
    --skip-dns) SKIP_DNS=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install.sh: unknown argument $1" >&2; usage >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

[ -n "$ADMIN_HOST" ] || ADMIN_HOST="admin.skw.test"
# `docker-compose.yml` requires ACME_EMAIL (`${ACME_EMAIL:?…}`), and it is not a
# SKW_ name — §4.3's table carries deployment facts, and Let's Encrypt's contact
# address is not one the app reads. Generated here so `compose up` can interpolate.
[ -n "$EMAIL" ] || EMAIL="admin@$ADMIN_HOST"
# A bundle carries its seed beside the database it describes (`data/control.seed.json`,
# §11.6 / E-19); a source tree carries the frozen one under `schema/`.
if [ -z "$SEED" ]; then
  if [ -f "data/control.seed.json" ]; then SEED="data/control.seed.json"; else SEED="schema/control.seed.json"; fi
fi
DATA_DIR="$(mkdir -p "$TARGET" && cd "$TARGET" && pwd)"
CONTROL_DB="$DATA_DIR/control.db"
ENROLMENT="$DATA_DIR/first-login.txt"
ADMIN_ORIGIN="https://$ADMIN_HOST"
# `docker compose` reads ./.env by default. `SKW_ENV_FILE` exists so a gate can
# install into a scratch tree without writing the repository's .env — two runs
# sharing one .env would share one SKW_SESSION_KEY and one SKW_DATA_DIR.
ENV_FILE="${SKW_ENV_FILE:-.env}"

say() { printf 'install: %s\n' "$*"; }
fail() { printf 'install: REFUSAL: %s\n' "$*" >&2; }

# --- 0. the install tools: node, and node:sqlite (exit 18) --------------------
# A bundle's verifier and seed tool read SQLite through `node:sqlite`, so the box needs
# node >= 22.5 and nothing else. Checked before anything is written: a missing module
# discovered halfway through is a half-installed box.
if ! node --no-warnings -e 'const { DatabaseSync } = require("node:sqlite"); new DatabaseSync(":memory:").close();' 2>/dev/null; then
  fail "node $(node --version 2>/dev/null || echo '(none)') cannot load node:sqlite; installs need node >= 22.5"
  exit 18
fi

# --- 1. DNS (§11.6: a wrong A record exits 11 in 0.3 s) ----------------------
if [ -n "$DOMAIN" ] && [ "$SKIP_DNS" -eq 0 ]; then
  started=$(date +%s)
  if ! getent hosts "$DOMAIN" >/dev/null 2>&1 && ! host "$DOMAIN" >/dev/null 2>&1; then
    fail "no A record for $DOMAIN"
    exit 11
  fi
  say "dns: $DOMAIN resolves ($(( $(date +%s) - started ))s)"
fi

# --- 2. bundle verification (exit 12) ---------------------------------------
# The verdict is *honoured*, not merely printed: every branch below depends on this exit.
if [ -f "$BUNDLE/BUNDLE.json" ]; then
  say "verify: BUNDLE.json present, checking every sha256"
  node --no-warnings tools/bundle_verify.mjs --bundle "$BUNDLE" || { fail "bundle verification failed"; exit 12; }
else
  say "verify: no BUNDLE.json at $BUNDLE (source tree install); nothing to hash"
fi

# --- 3. control.sql (exit 15) -----------------------------------------------
if [ -f "$CONTROL_DB" ] && [ "$FORCE" -eq 0 ]; then
  say "schema: $CONTROL_DB exists, left alone"
else
  rm -f "$CONTROL_DB" "$CONTROL_DB-wal" "$CONTROL_DB-shm"
  VERSION="$(node --no-warnings tools/control_db.mjs apply --db "$CONTROL_DB" --file schema/control.sql)" || {
    # An empty control.db left behind would be read as "already installed" by the next
    # run. A failed apply removes its own artefact.
    rm -f "$CONTROL_DB" "$CONTROL_DB-wal" "$CONTROL_DB-shm"
    fail "schema/control.sql did not apply to $CONTROL_DB"
    exit 15
  }
  say "schema: control.sql applied to $CONTROL_DB ($VERSION)"
fi

# --- 4. seed, one transaction, version-checked (§11.6) ---------------------
if [ "$(node --no-warnings tools/control_db.mjs scalar --db "$CONTROL_DB" --sql 'SELECT count(*) FROM tenant')" = "0" ]; then
  node --no-warnings tools/seed_control.mjs --db "$CONTROL_DB" --seed "$SEED" || { fail "the seed did not apply"; exit 15; }
else
  say "seed: tenants already present, left alone"
fi

# --- 5. the tenant's own database (§12.2: data/tenants/<key>/site.db) ------
# A bundle carries the tenant's bytes at `data/site.db`; the app looks for them at
# `<data>/tenants/<key>/site.db` and nowhere else (`app/main.ts` derives the path from
# the control-plane row). Without this step the install succeeds and every page 503s —
# which is exactly the failure "install is done" must not be able to mean.
if [ -f "$BUNDLE/data/site.db" ]; then
  node --no-warnings tools/control_db.mjs tenants --db "$CONTROL_DB" | while IFS=$'\t' read -r key mode status; do
    [ -n "$key" ] || continue
    dest="$DATA_DIR/tenants/$key/site.db"
    if [ -f "$dest" ]; then
      say "tenant: $key site.db present, left alone"
    else
      mkdir -p "$DATA_DIR/tenants/$key"
      cp "$BUNDLE/data/site.db" "$dest"
      chmod 0644 "$dest"
      say "tenant: $key site.db installed from the bundle ($mode, $status)"
    fi
  done
fi

# --- 6. .env (never overwritten, 0600) --------------------------------------
if [ -f "$ENV_FILE" ]; then
  say "env: $ENV_FILE exists, left alone"
else
  umask 077
  key() { node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'; }
  mkdir -p "$(dirname "$ENV_FILE")"
  cat > "$ENV_FILE" <<EOF
# Generated by install.sh. 0600. Never commit this file.
SKW_DATA_DIR=/srv/data
SKW_BUILD_ID=install-$(date +%Y%m%d%H%M%S)
SKW_EDGE_TOKEN=$(key)
SKW_EDGE_TRUSTED_CIDRS=127.0.0.1/32,172.16.0.0/12
SKW_SESSION_KEY=$(key)
SKW_DOWNLOAD_TOKEN_KEY=$(key)
SKW_IP_HASH_KEY=$(key)
SKW_ADMIN_ORIGIN=$ADMIN_ORIGIN
SKW_ARGON2_MAX_CONCURRENT=4
SKW_RENDER_MODE=live
SKW_SCHEMA_EDIT=off
SKW_FLEET_MODE=0
SKW_EMAIL_MODE=off
# §9.1a (E-17): empty in every exported bundle. Empty means TOTP is mandatory.
SKW_ADMIN_ALLOWLIST=
UV_THREADPOOL_SIZE=8
ACME_EMAIL=$EMAIL
EOF
  chmod 0600 "$ENV_FILE"
  say "env: $ENV_FILE written (0600) with a fresh key per install"
fi

# --- 7. bootstrap (D30; exit 16, or 3 which is benign) ----------------------
# The command reads SKW_DATA_DIR, so it needs the install target and the two keys
# it prints. It is a `migrate`-class process: no app-only assertions.
set -a
# shellcheck disable=SC1091
. "$ENV_FILE"
set +a
export SKW_DATA_DIR="$DATA_DIR"

# Where `skwctl` comes from. A source tree has `./dist`; a bundle does not, and the
# one step that needs the image's native modules is this one (argon2 + better-sqlite3).
if [ -z "$RUNTIME" ] && [ -f "$ROOT/dist/app/cli/skwctl.js" ]; then
  RUNTIME="$ROOT"
fi
if [ -z "$RUNTIME" ] && [ -n "${SKW_RUNTIME_DIR:-}" ] && [ -f "$SKW_RUNTIME_DIR/dist/app/cli/skwctl.js" ]; then
  RUNTIME="$SKW_RUNTIME_DIR"
fi

set +e
BOOTSTRAP_VIA="local"
if [ -n "$RUNTIME" ]; then
  say "runtime: $RUNTIME"
  node "$RUNTIME/dist/app/cli/skwctl.js" admin bootstrap \
    --generate-password --enrolment-out "$ENROLMENT"
  BOOTSTRAP_STATUS=$?
else
  BOOTSTRAP_VIA="container"
  # Production path: the bundle's own compose file, the image it was cut from. The
  # enrolment file has to land on the mount the host reads, so only `./data` works.
  if [ "$DATA_DIR" != "$ROOT/data" ]; then
    fail "no app runtime at $ROOT/dist and --target is not ./data; pass --runtime DIR or build the image"
    exit 19
  fi
  say "runtime: docker compose run app (no dist/ in this tree)"
  # `--entrypoint node`: the image's ENTRYPOINT is `node dist/app/main.js`, so a bare
  # `run app node dist/app/cli/skwctl.js` appends the CLI to the **server's** argv and boots
  # the app instead of running skwctl (measured: the command hung until the 120 s timeout).
  docker compose run --rm --no-deps -T --entrypoint node app dist/app/cli/skwctl.js admin bootstrap \
    --generate-password --enrolment-out /srv/data/first-login.txt
  BOOTSTRAP_STATUS=$?
fi
set -e

case "$BOOTSTRAP_STATUS" in
  0) say "bootstrap: enrolment written to $ENROLMENT (0600)" ;;
  3) say "bootstrap: this box is already set up; nothing changed (exit 3)" ;;
  *)
    if [ "$BOOTSTRAP_VIA" = "container" ]; then
      fail "the app image could not run skwctl (see the compose error above): a bundle install needs --runtime DIR or a pullable image"
    else
      fail "skwctl admin bootstrap failed with exit $BOOTSTRAP_STATUS"
    fi
    exit 16
    ;;
esac

# --- 7b. the default TLS pair (S4d) ------------------------------------------
# Every `listen 443 ssl` block names a certificate. ACME issues per host into
# certs/<host>.crt; before the first issuance, and for the admin/demos vhosts, nginx needs
# a pair that exists. Self-signed, 10 years, and never served for a host that has its own
# certificate in the block (a tenant with cert_state=issued points at its own pair).
if [ ! -f "$ROOT/certs/default.crt" ] || [ ! -f "$ROOT/certs/default.key" ]; then
  mkdir -p "$ROOT/certs"
  if ! command -v openssl >/dev/null 2>&1; then
    fail "openssl is required to write certs/default.crt before nginx starts"
    exit 17
  fi
  openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
    -subj "/CN=skunkworks-default" \
    -keyout "$ROOT/certs/default.key" -out "$ROOT/certs/default.crt" 2>/dev/null
  chmod 600 "$ROOT/certs/default.key"
  say "certs: self-signed default pair written to certs/ (a pending host still answers on 80)"
fi

# --- 8. compose up (exit 17) ------------------------------------------------
if [ "$COMPOSE" -eq 1 ]; then
  if ! docker compose up -d; then
    fail "docker compose up -d failed"
    exit 17
  fi
  say "compose: up"
else
  say "compose: skipped (--no-compose)"
fi

# --- 9. the install's own smoke test ---------------------------------------
if [ "$VERIFY_LOGIN" -eq 1 ]; then
  if [ ! -f "$ENROLMENT" ]; then
    say "verify-login: skipped (this box was already bootstrapped; no enrolment file)"
  elif [ -z "$RUNTIME" ]; then
    say "verify-login: skipped (no local runtime; the container is the smoke test)"
  else
    # A bundle install must serve a page; a source-tree install has no tenant content yet,
    # so the probe reports instead of failing (the install's own gate, D30).
    PAGE_FLAG=""
    [ -f "$BUNDLE/data/site.db" ] && PAGE_FLAG="--require-page"
    node --no-warnings "$RUNTIME/tools/install_check.mjs" --data "$DATA_DIR" --enrolment "$ENROLMENT" \
      --content "$ROOT/content" $PAGE_FLAG
  fi
fi

say "done. Sign in at $ADMIN_ORIGIN/admin/login, then delete $ENROLMENT."
