#!/usr/bin/env bash
#
# Made to Ship — put this site on the local Skunkworks stack, at dev-madetoship.com.
#
#   sites/madetoship/deploy.sh            # everything, end to end
#   sites/madetoship/deploy.sh --verify   # only read back what is live
#
# Run it from anywhere; the script cd's to the repository root itself. It is idempotent: a second
# run adds no tenant, rewrites the same six pages, replaces the theme and the two menus, and
# reports what it found rather than what it hoped for.
#
# ## Why the app is stopped for **every** write, not just the tenant's control row
#
# `control.db` and each tenant's `site.db` are SQLite databases the app container owns. Two things
# go wrong when the host writes them under a live app:
#
#   - SQLite answers `SQLITE_READONLY` to the second writer, and has produced a `database disk image
#     is malformed` read cured only by checkpointing;
#   - worse, and measured here: the app keeps the tenant database open, the host's write checkpoints
#     and removes the WAL behind it, and the app's *next* write fails with `SqliteError: disk I/O
#     error` while every read keeps working. The symptom is a contact form that returns 500 and a
#     database that passes `integrity_check`.
#
# So the whole write sequence — tenant, packages, pages, theme, edge config — runs with the app
# down, and the app comes back once. The CMS is the writer; this host is a guest, and a guest does
# not write over the host's shoulder.
#
# ## What this box needs, and what it does not
#
# Docker, Node 22 (with `--experimental-strip-types`) and openssl. No build step: the app image is
# already running, the pages are rows, and the theme is a package on the tenant's own volume. A
# theme change or a code change is the only reason to rebuild an image.
#
# The DNS side is deliberately not touched: `dev-madetoship.com` must resolve to 127.0.0.1 on this
# machine for a browser to reach the stack. The script checks and prints the line to add; it does
# not edit /etc/hosts, because that needs root and is a decision, not a build step.
set -euo pipefail

TENANT="madetoship"
HOST="dev-madetoship.com"
SITE_NAME="Made to Ship"
OWNER_EMAIL="hello@madetoship.com"
DATA_DIR="data"
SITE_DIR="sites/madetoship"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

NODE=(node --no-warnings --experimental-strip-types)
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

APP_STOPPED=0
start_app() {
  if [ "$APP_STOPPED" = "1" ]; then
    docker compose start app >/dev/null 2>&1 || true
    APP_STOPPED=0
  fi
}
trap 'start_app' EXIT

# ---------------------------------------------------------------- read back what is running

if [ "${1:-}" = "--verify" ]; then
  say "Reading back https://$HOST"
  "${NODE[@]}" "$SITE_DIR/verify.ts" --host "$HOST" --data "$DATA_DIR" --tenant "$TENANT"
  exit $?
fi

say "Tenant $TENANT at $HOST"
docker compose stop app >/dev/null
APP_STOPPED=1
printf '    app stopped (one writer at a time)\n'

"${NODE[@]}" scripts/add-tenant.ts \
  --key "$TENANT" --host "$HOST" --name "$SITE_NAME" \
  --email "$OWNER_EMAIL" \
  --data "$DATA_DIR" | sed 's/^/    /'

# A self-signed pair per host, minted only when absent: the ACME service replaces it on a box with
# a public DNS record, and re-running must never downgrade a real certificate.
"${NODE[@]}" tools/install_certs.mjs --data "$DATA_DIR" --certs "$DATA_DIR/certs" \
  --default-host "admin.abc123.com" --default-host "demos.abc123.com" | sed 's/^/    /'

# ------------------------------------------------------------------------------- the packages

say "Packages: menu 1.0.0, contact 1.2.0"
# The installer refuses an untested package. These are the repository's own package tests; their
# exit status is carried into the report the installer reads and writes.
set +e
node --test --test-concurrency=1 test/plugin-menu.test.ts test/plugin-shipped-packages.test.ts \
  > "/tmp/$TENANT-plugin-tests.log" 2>&1
TEST_EXIT=$?
set -e
sed -n 's/^# \(tests\|pass\|fail\) /    test \1 /p' "/tmp/$TENANT-plugin-tests.log"
[ "$TEST_EXIT" -eq 0 ] || { printf '    tests failed — see %s\n' "/tmp/$TENANT-plugin-tests.log"; exit 1; }

"${NODE[@]}" "$SITE_DIR/install-plugins.ts" \
  --tenant "$TENANT" --data "$DATA_DIR" --tests-exit "$TEST_EXIT" | sed 's/^/    /'

# ---------------------------------------------------------------------------------- the pages

say "Pages, menus and settings"
"${NODE[@]}" "$SITE_DIR/seed.ts" --tenant "$TENANT" --data "$DATA_DIR" | sed 's/^/    /'

# ----------------------------------------------------------------------------------- the look

say "Theme"
"${NODE[@]}" "$SITE_DIR/build.ts" | sed 's/^/    /'
"${NODE[@]}" app/cli/theme.ts import "$SITE_DIR/dist/theme" --data-dir "$DATA_DIR" --replace | sed 's/^/    /'
"${NODE[@]}" app/cli/theme.ts activate "$TENANT" --tenant "$TENANT" --data-dir "$DATA_DIR" --replace --force | sed 's/^/    /'
"${NODE[@]}" app/cli/theme.ts list --tenant "$TENANT" --data-dir "$DATA_DIR" | sed 's/^/    /'

# ------------------------------------------------------------------------------------ the edge

say "Edge"
SKW_ADMIN_ORIGIN="$(grep -E '^SKW_ADMIN_ORIGIN=' .env | cut -d= -f2-)" \
  "${NODE[@]}" tools/nginx_gen.ts --data-dir "$DATA_DIR" --out "$DATA_DIR/nginx/10-app.conf" | sed 's/^/    /'

# The container runs as uid 10001: after the host has finished writing this tenant's files it must
# be able to write them again — its WAL beside `site.db`, its own copies of the theme assets.
# `a+rwX` gives that uid what the host's umask took away; ownership is not carried across the
# bind mount, so the mode is the whole handshake.
chmod -R a+rwX "$DATA_DIR/tenants/$TENANT"
find "$DATA_DIR/tenants/$TENANT" -type d -exec chmod 777 {} +
find "$DATA_DIR/tenants/$TENANT" -type f -exec chmod 666 {} +

docker compose start app >/dev/null
APP_STOPPED=0
# The app boots in a second or two; a read-back that starts before the listener exists measures the
# boot, not the site (it answered 502 once). Wait for its own health check rather than for a sleep.
for _ in $(seq 1 40); do
  if docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
printf '    app started\n'

docker compose exec -T nginx nginx -t 2>&1 | sed 's/^/    /'
docker compose exec -T nginx nginx -s reload
printf '    nginx reloaded\n'

# ------------------------------------------------------------------------------ the read back

say "Verifying https://$HOST"
if ! grep -qE "(^|[[:space:]])${HOST}([[:space:]]|$)" /etc/hosts; then
  printf '    %s does not resolve on this machine yet. Add it once:\n' "$HOST"
  printf '      sudo sh -c '"'"'printf "\\n127.0.0.1 %s\\n" >> /etc/hosts'"'"'\n' "$HOST"
fi
"${NODE[@]}" "$SITE_DIR/verify.ts" --host "$HOST" --data "$DATA_DIR" --tenant "$TENANT"

say "The owner credential and the tenant's console"
"${NODE[@]}" "$SITE_DIR/verify-admin.ts" --host "$HOST" --data "$DATA_DIR" --tenant "$TENANT"

printf '\n    admin:  https://%s/admin  (tenant %s; credentials in %s/enrol-%s.txt)\n\n' \
  "$HOST" "$TENANT" "$DATA_DIR" "$TENANT"
