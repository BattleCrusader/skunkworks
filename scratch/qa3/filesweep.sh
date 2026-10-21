#!/bin/bash
# QA3: one gate file at a time, through the shipped runner, with the box load beside it.
set -u
cd /Volumes/Backup/Development/skunkworks || exit 99
out=scratch/qa3
files=(
  test/plugin-scope.test.ts
  test/plugin-load.test.ts
  test/plugin-hooks-wired.test.ts
  test/plugin-revocation.test.ts
  test/plugin-trust.test.ts
  test/admin-plugin-notices.test.ts
  test/plugin-activation-seq.test.ts
  test/plugin-sync-handle.test.ts
  test/export-determinism.test.ts
  test/download-consume.test.ts
  test/download-redeem.test.ts
  test/nginx-media-e2e.test.ts
  test/farm.test.ts
  test/install-bundle.test.ts
  test/install.test.ts
  test/first-boot-tls.test.ts
)
for f in "${files[@]}"; do
  name=$(echo "$f" | sed 's#/#_#g')
  load_before=$(sysctl -n vm.loadavg | tr -d '{}')
  start=$(date +%s)
  node scripts/run-node-tests.mjs --timeout=126000 "$f" >"$out/file-$name.log" 2>&1
  code=$?
  end=$(date +%s)
  load_after=$(sysctl -n vm.loadavg | tr -d '{}')
  printf '%-42s exit=%s %3ss load:%s ->%s | %s %s %s\n' "$f" "$code" "$((end-start))" "$load_before" "$load_after" \
    "$(grep -m1 '^# tests' "$out/file-$name.log")" "$(grep -m1 '^# pass' "$out/file-$name.log")" "$(grep -m1 '^# fail' "$out/file-$name.log")"
done
echo "=== FILE SWEEP DONE"
