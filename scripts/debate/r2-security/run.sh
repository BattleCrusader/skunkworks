#!/usr/bin/env bash
# Re-runs every measurement cited in docs/debate/r2-security.md.
# Needs: node 22, sqlite3 CLI, and a node_modules containing better-sqlite3 + @node-rs/argon2.
#   export SK_R2_REQUIRE=/path/to/package.json   # resolves those two modules
#   export SK_R2_BASE=/tmp/sk-r2sec              # scratch root (wiped)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export SK_R2_BASE="${SK_R2_BASE:-/tmp/sk-r2sec}"
export SK_R2_REQUIRE="${SK_R2_REQUIRE:-$HERE/package.json}"
rm -rf "$SK_R2_BASE"; mkdir -p "$SK_R2_BASE/perm/tenant/acme" "$SK_R2_BASE/perm/tenant/beta"

echo "########## M1 — readonly handle capabilities ##########"
node "$HERE/p1-ro.mjs"

echo
echo "########## M2 — argon2id params vs memory ##########"
for cfg in "1 19456 2 1" "8 19456 2 1" "1 65536 3 1" "8 65536 3 1"; do
  set -- $cfg
  echo "--- N=$1 m=$2 t=$3 p=$4 (UV_THREADPOOL_SIZE=8) ---"
  UV_THREADPOOL_SIZE=8 /usr/bin/time -l node "$HERE/p2-argon-child.mjs" "$1" "$2" "$3" "$4" 2>&1 \
    | grep -E '^\{|maximum resident set size'
done
echo "--- default UV_THREADPOOL_SIZE (4) ---"
for cfg in "8 19456 2 1" "8 65536 3 1"; do
  set -- $cfg
  echo "N=$1 m=$2 t=$3 p=$4"
  /usr/bin/time -l node "$HERE/p2-argon-child.mjs" "$1" "$2" "$3" "$4" 2>&1 | grep -E '^\{|maximum resident set size'
done
echo "--- 16 concurrent at 64 MiB, pool 16 ---"
UV_THREADPOOL_SIZE=16 /usr/bin/time -l node "$HERE/p2-argon-child.mjs" 16 65536 3 1 2>&1 | grep -E '^\{|maximum resident set size'

echo
echo "########## M3 — selector/verifier lookup ##########"
node "$HERE/p3-selector.mjs"

echo
echo "########## M4 — node --permission as a tenant-code boundary ##########"
sqlite3 "$SK_R2_BASE/perm/control.db" "CREATE TABLE sessions(id TEXT, tenant TEXT); INSERT INTO sessions VALUES('s0','beta');"
sqlite3 "$SK_R2_BASE/perm/tenant/acme/site.db" "CREATE TABLE cms_pages(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO cms_pages VALUES(1,'acme');"
sqlite3 "$SK_R2_BASE/perm/tenant/beta/site.db" "CREATE TABLE cms_download_code(id INTEGER PRIMARY KEY, code_hash TEXT, issued_to_email TEXT); INSERT INTO cms_download_code VALUES(1,'argon2id\$abc','buyer@beta.example');"
NM="$(dirname "$SK_R2_REQUIRE")/node_modules"
echo "--- no --allow-addons (SQLite cannot load at all) ---"
node --permission --allow-fs-read="$SK_R2_BASE/perm/tenant/acme" --allow-fs-read="$NM" --allow-fs-read="$SK_R2_REQUIRE" \
  "$HERE/p4-perm-child.mjs" 2>&1 | grep -vE '^\s+at |^$' | head -20
rm -f "$SK_R2_BASE/perm/tenant/beta/pwn.txt" "$SK_R2_BASE/perm/tenant/beta/exfil.db"
echo "--- with --allow-addons (the native addon bypasses the fs policy) ---"
node --permission --allow-addons --allow-fs-read="$SK_R2_BASE/perm/tenant/acme" --allow-fs-read="$NM" --allow-fs-read="$SK_R2_REQUIRE" \
  "$HERE/p4-perm-child.mjs" 2>&1 | grep -vE '^\s+at |^$|SecurityWarning|trace-warnings' | head -20

echo
echo "########## M5 — cost of a per-tenant process ##########"
node "$HERE/p5-proc.mjs"
/usr/bin/time -l node "$HERE/p5-proc-child.mjs" 2>&1 | grep -E 'READY|maximum resident set size'

echo
echo "########## M6 — the accounting unit (jti claim) ##########"
node "$HERE/p6-jti.mjs"

echo
echo "########## M7 — audit chain + daily seal ##########"
node "$HERE/p7-audit.mjs"
