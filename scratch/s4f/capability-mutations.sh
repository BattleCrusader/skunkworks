#!/usr/bin/env bash
# S4f — the two-layer capability proof, as two mutations, each restored by hash.
#
#   M1  disable the RUNNER's check (server.mjs): C1/C1c must go red, C2 must stay green.
#   M2  disable the HOST's check (host.ts):        C2 must go red, C1 must stay green.
#
# Each gate therefore fails on the layer it names and only on that layer.
set -u
cd "$(dirname "$0")/../.." || exit 1
OUT=scratch/s4f/mutations
mkdir -p "$OUT"

restore() { # $1 = file, $2 = backup
  cp "$2" "$1"
  local before after
  before=$(shasum -a 256 "$2" | awk '{print $1}')
  after=$(shasum -a 256 "$1" | awk '{print $1}')
  if [ "$before" = "$after" ]; then
    echo "restored $1  sha256=$after  identical=yes"
  else
    echo "RESTORE FAILED $1  $before != $after"; exit 1
  fi
}

run_gate() { # $1 = log name
  node scripts/run-node-tests.mjs --timeout=180000 test/plugin-capability.test.ts >"$OUT/$1.log" 2>&1
  echo "exit=$?"
  grep -E '^(ok|not ok) ' "$OUT/$1.log" | sed 's/ —.*//'
}

echo '=== M1: the runner does not check the grant ==='
cp runner/server.mjs "$OUT/server.mjs.backup"
python3 - <<'PY'
import re, pathlib
p = pathlib.Path('runner/server.mjs')
s = p.read_text()
old = """  if (!binding.granted.has(op)) {"""
new = """  if (false && !binding.granted.has(op)) {"""
assert old in s, 'runner check not found'
p.write_text(s.replace(old, new, 1))
print('mutated: runner capability check disabled')
PY
run_gate M1-runner-check-disabled
restore runner/server.mjs "$OUT/server.mjs.backup"

echo '=== M2: the host does not check the capability ==='
cp app/plugins/host.ts "$OUT/host.ts.backup"
python3 - <<'PY'
import pathlib
p = pathlib.Path('app/plugins/host.ts')
s = p.read_text()
old = """      if (!row.manifest.capabilities.includes(op)) {
        throw new Error(`SKW_E_PL_REJECTED: ${op} is not in ${plugin}'s declared capabilities`);
      }"""
new = """      if (false) {
        throw new Error(`SKW_E_PL_REJECTED: ${op} is not in ${plugin}'s declared capabilities`);
      }"""
assert old in s, 'host check not found'
p.write_text(s.replace(old, new, 1))
print('mutated: host capability check disabled')
PY
run_gate M2-host-check-disabled
restore app/plugins/host.ts "$OUT/host.ts.backup"

echo '=== restored tree: both gates green again ==='
run_gate after-restore
