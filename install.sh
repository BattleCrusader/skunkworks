#!/usr/bin/env bash
# install.sh — verify → control.sql → seed → .env → bootstrap → compose up
#              (SDS §11.6, errata E-19, D30)
#
# Exit codes, and what each one means to whoever runs this:
#
#   0   installed, or already bootstrapped (bootstrap exit 3 is benign: nothing changed)
#   11  the A record for --domain does not point at this box (0.3 s, §11.6)
#   12  bundle verification failed — a sha256 or a symlink target disagrees
#   15  control.db could not be created or migrated
#   16  `skwctl admin bootstrap` failed for a reason other than "already bootstrapped"
#   17  `docker compose up` failed  (an addition: §11.6 names no code for it)
#
# `--no-compose` stops after bootstrap, which is what the S2b gate measures: the
# released image digest is S4's artefact and does not exist locally, so a compose
# step here would test the registry rather than this slice.
#
# `--verify-login` boots the installed app in-process, logs in with the password
# and the TOTP secret from the enrolment file, and fetches GET /admin. That is the
# install's own smoke test, and it is the only step that proves the box is usable.
set -euo pipefail

TARGET="data"
BUNDLE="."
SEED=""
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
  --seed FILE         seed file (default: schema/control.seed.json)
  --admin-host HOST   the admin hostname (default: admin.skw.test)
  --email ADDRESS     the ACME contact address (default: admin@<admin host>)
  --domain DOMAIN     the tenant's domain; enables the DNS check (exit 11)
  --skip-dns          do not check DNS even when --domain is given
  --no-compose        stop after bootstrap; do not run `docker compose up -d`
  --verify-login      after install, log in end to end and fetch GET /admin
  --force             re-run the DDL/seed steps on an existing data directory
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --bundle) BUNDLE="$2"; shift 2 ;;
    --seed) SEED="$2"; shift 2 ;;
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
[ -n "$SEED" ] || SEED="schema/control.seed.json"
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
if [ -f "$BUNDLE/BUNDLE.json" ]; then
  say "verify: BUNDLE.json present, checking every sha256"
  node tools/bundle_verify.mjs --bundle "$BUNDLE" || { fail "bundle verification failed"; exit 12; }
else
  say "verify: no BUNDLE.json at $BUNDLE (source tree install); nothing to hash"
fi

# --- 3. control.sql (exit 15) -----------------------------------------------
if [ -f "$CONTROL_DB" ] && [ "$FORCE" -eq 0 ]; then
  say "schema: $CONTROL_DB exists, left alone"
else
  rm -f "$CONTROL_DB" "$CONTROL_DB-wal" "$CONTROL_DB-shm"
  if ! sqlite3 "$CONTROL_DB" < schema/control.sql; then
    fail "schema/control.sql did not apply to $CONTROL_DB"
    exit 15
  fi
  say "schema: control.sql applied to $CONTROL_DB (v$(sqlite3 "$CONTROL_DB" 'PRAGMA user_version'))"
fi

# --- 4. seed, one transaction (§11.6) ---------------------------------------
if [ "$(sqlite3 "$CONTROL_DB" 'SELECT count(*) FROM tenant')" = "0" ]; then
  node tools/seed_control.mjs --db "$CONTROL_DB" --seed "$SEED" || { fail "the seed did not apply"; exit 15; }
else
  say "seed: tenants already present, left alone"
fi

# --- 5. .env (never overwritten, 0600) --------------------------------------
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
UV_THREADPOOL_SIZE=8
ACME_EMAIL=$EMAIL
EOF
  chmod 0600 "$ENV_FILE"
  say "env: $ENV_FILE written (0600) with a fresh key per install"
fi

# --- 6. bootstrap (D30; exit 16, or 3 which is benign) ----------------------
# The command reads SKW_DATA_DIR, so it needs the install target and the two keys
# it prints. It is a `migrate`-class process: no app-only assertions.
set -a
# shellcheck disable=SC1091
. "$ENV_FILE"
set +a
export SKW_DATA_DIR="$DATA_DIR"

set +e
node dist/app/cli/skwctl.js admin bootstrap \
  --generate-password --enrolment-out "$ENROLMENT"
BOOTSTRAP_STATUS=$?
set -e

case "$BOOTSTRAP_STATUS" in
  0) say "bootstrap: enrolment written to $ENROLMENT (0600)" ;;
  3) say "bootstrap: this box is already set up; nothing changed (exit 3)" ;;
  *) fail "skwctl admin bootstrap failed with exit $BOOTSTRAP_STATUS"; exit 16 ;;
esac

# --- 7. compose up (exit 17) ------------------------------------------------
if [ "$COMPOSE" -eq 1 ]; then
  if ! docker compose up -d; then
    fail "docker compose up -d failed"
    exit 17
  fi
  say "compose: up"
else
  say "compose: skipped (--no-compose)"
fi

# --- 8. the install's own smoke test ---------------------------------------
if [ "$VERIFY_LOGIN" -eq 1 ]; then
  if [ ! -f "$ENROLMENT" ]; then
    say "verify-login: skipped (this box was already bootstrapped; no enrolment file)"
  else
    node tools/install_check.mjs --data "$DATA_DIR" --enrolment "$ENROLMENT"
  fi
fi

say "done. Sign in at $ADMIN_ORIGIN/admin/login, then delete $ENROLMENT."
