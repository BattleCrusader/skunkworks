#!/bin/bash
# QA S3 — the negative controls.
#
# Each control: hash the file, back it up, break exactly one mechanism, run the gate that
# claims to own it, restore from the backup, hash again. A control that does not turn its
# gate red is reported as a dead gate, not as a pass.
set -u
cd /Volumes/Backup/Development/skunkworks || exit 1
OUT=scratch/qa-s3/controls.log
: > "$OUT"

run_gate() { # name, timeout, pattern, file...
  local name=$1; shift
  local timeout=$1; shift
  local pattern=$1; shift
  echo "--- GATE $name" >> "$OUT"
  node --test --test-concurrency=1 --test-timeout="$timeout" --test-name-pattern="$pattern" "$@" >> "$OUT" 2>&1
  echo "--- GATE $name exit=$?" >> "$OUT"
}

control() { # label, file, python-mutation, gate-name, timeout, pattern, gate-file
  local label=$1 file=$2 mut=$3 gname=$4 gtimeout=$5 gpat=$6 gfile=$7
  local before after mutated
  before=$(shasum -a 256 "$file" | awk '{print $1}')
  cp "$file" "scratch/qa-s3/$(basename "$file").bak"
  python3 - "$file" <<PY
import sys, pathlib
p = pathlib.Path(sys.argv[1])
s = p.read_text()
$mut
p.write_text(s)
PY
  mutated=$(shasum -a 256 "$file" | awk '{print $1}')
  echo "=== CONTROL $label" >> "$OUT"
  echo "file: $file" >> "$OUT"
  echo "sha256 before:   $before" >> "$OUT"
  echo "sha256 broken:   $mutated" >> "$OUT"
  run_gate "$gname" "$gtimeout" "$gpat" "$gfile"
  cp "scratch/qa-s3/$(basename "$file").bak" "$file"
  after=$(shasum -a 256 "$file" | awk '{print $1}')
  echo "sha256 restored: $after" >> "$OUT"
  if [ "$before" = "$after" ]; then echo "RESTORE: IDENTICAL" >> "$OUT"; else echo "RESTORE: MISMATCH" >> "$OUT"; fi
  echo "" >> "$OUT"
}

control "C1 one-use accounting" app/download/ledger.ts \
  's = s.replace("    if (inserted.changes === 1) {", "    if (true) {", 1)' \
  "C1 download-consume" 120000 "C1|C2|C3" test/download-consume.test.ts

control "C2 gated absence" app/assets/farm.ts \
  's = s.replace("  if (row.access_class === \x27gated\x27) {", "  if (row.access_class === \x27never-gated-in-this-mutation\x27) {", 1)' \
  "C2 farm F2" 120000 "F2" test/farm.test.ts

control "C5 D31 publish refusal" app/sources/publish.ts \
  's = s.replace("{ defaultAboveMax: \x27refuse\x27 }", "{ defaultAboveMax: \x27clamp\x27 }", 1)' \
  "C5 d31" 120000 "D31" test/d31-limit.test.ts

control "C3 watermark fail-closed" app/download/plane.ts \
  's = s.replace("      if (stampable(asset) !== null) {", "      if (false \&\& stampable(asset) !== null) {", 1)' \
  "C3 watermark W4" 120000 "W4" test/download-watermark.test.ts

control "C4a farm served without Node (immutability header)" nginx/templates/server.tmpl \
  's = s.replace("        add_header Cache-Control \"public, max-age=31536000, immutable\";", "        add_header Cache-Control \"no-store\";", 1)' \
  "C4a nginx N1" 180000 "N1" test/nginx-media-e2e.test.ts

control "C4b farm moved behind Node (config shape)" nginx/templates/server.tmpl \
  's = s.replace("        alias /srv/content/public/;\n        try_files \$uri =404;", "        proxy_pass http://app:3000;", 1)' \
  "C4b nginx N1" 180000 "N1" test/nginx-media-e2e.test.ts

echo "done" >> "$OUT"
