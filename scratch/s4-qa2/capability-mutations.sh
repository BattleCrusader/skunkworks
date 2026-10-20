#!/usr/bin/env bash
# S4 QA round 2 — disable each capability layer in turn and record exactly which gate reddens.
set -u
cd "$(dirname "$0")/../.."
OUT=scratch/s4-qa2/cap
mkdir -p "$OUT"

run_gate() {
  node scripts/run-node-tests.mjs --timeout=120000 test/plugin-capability.test.ts > "$1" 2>&1
  echo "exit=$?" >> "$1"
}

hash() { shasum -a 256 "$1" | awk '{print $1}'; }

# --- baseline ---------------------------------------------------------------------------
run_gate "$OUT/baseline.log"
grep -E "^(ok|not ok) " "$OUT/baseline.log" | sed 's/ - .*//' | head -8 > "$OUT/baseline.names"
echo "baseline: $(grep -cE '^ok ' "$OUT/baseline.log") ok, $(grep -cE '^not ok' "$OUT/baseline.log") not ok, $(tail -1 "$OUT/baseline.log")"

# --- M1: the runner's own check gone ------------------------------------------------------
R_BEFORE=$(hash runner/server.mjs)
cp runner/server.mjs "$OUT/server.mjs.bak"
perl -0pi -e 's/  if \(!binding\.granted\.has\(op\)\) \{/  if (false \&\& !binding.granted.has(op)) {/' runner/server.mjs
grep -n "binding.granted.has(op)" runner/server.mjs
run_gate "$OUT/M1-runner-check-disabled.log"
echo "M1: $(grep -cE '^ok ' "$OUT/M1-runner-check-disabled.log") ok, $(grep -cE '^not ok' "$OUT/M1-runner-check-disabled.log") not ok"
grep -E "^not ok" "$OUT/M1-runner-check-disabled.log" | sed 's/ - / | /' | cut -c1-160
cp "$OUT/server.mjs.bak" runner/server.mjs
R_AFTER=$(hash runner/server.mjs)
[ "$R_BEFORE" = "$R_AFTER" ] && echo "M1 restore: byte-identical ($R_AFTER)" || echo "M1 restore: MISMATCH"

# --- M2: the host's own check gone -------------------------------------------------------
H_BEFORE=$(hash app/plugins/host.ts)
cp app/plugins/host.ts "$OUT/host.ts.bak"
perl -0pi -e "s/      if \(!row\.manifest\.capabilities\.includes\(op\)\) \{/      if (false \&\& !row.manifest.capabilities.includes(op)) {/" app/plugins/host.ts
grep -n "capabilities.includes(op)" app/plugins/host.ts
run_gate "$OUT/M2-host-check-disabled.log"
echo "M2: $(grep -cE '^ok ' "$OUT/M2-host-check-disabled.log") ok, $(grep -cE '^not ok' "$OUT/M2-host-check-disabled.log") not ok"
grep -E "^not ok" "$OUT/M2-host-check-disabled.log" | sed 's/ - / | /' | cut -c1-160
echo "--- M2 failure detail (the store.delete half) ---"
grep -A12 "^not ok" "$OUT/M2-host-check-disabled.log" | grep -E "store.delete|changes|AssertionError|ok:|rows" | head -12
cp "$OUT/host.ts.bak" app/plugins/host.ts
H_AFTER=$(hash app/plugins/host.ts)
[ "$H_BEFORE" = "$H_AFTER" ] && echo "M2 restore: byte-identical ($H_AFTER)" || echo "M2 restore: MISMATCH"

# --- restored ---------------------------------------------------------------------------
run_gate "$OUT/restored.log"
echo "restored: $(grep -cE '^ok ' "$OUT/restored.log") ok, $(grep -cE '^not ok' "$OUT/restored.log") not ok, $(tail -1 "$OUT/restored.log")"
