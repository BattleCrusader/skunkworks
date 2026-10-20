#!/usr/bin/env bash
# S4e mutation records: each gate is shown red against a real edit, then restored by hash.
set -uo pipefail
cd /Volumes/Backup/Development/skunkworks
OUT=scratch/s4e-mutations
mkdir -p "$OUT"

hash() { shasum -a 256 "$1" | awk '{print $1}'; }

run() { # name file testfile
  local name="$1" file="$2" test="$3"
  echo "=== $name"
  env -u PYTHONPATH -u PYTHONHOME node scripts/run-node-tests.mjs --timeout=400000 "$test" >"$OUT/$name.log" 2>&1
  local code=$?
  echo "exit=$code"
  grep -E "^not ok" "$OUT/$name.log" | head -4
  echo "restored sha256: $(hash "$file")"
}

mutate() { # file python-expression
  python3 - "$1" "$2" <<'PY'
import sys
path, expr = sys.argv[1], sys.argv[2]
src = open(path).read()
assert expr in src, f"mutation anchor not found in {path}: {expr[:60]}"
open(path, 'w').write(src.replace(expr, expr.replace('MUTATE', 'MUTATED') if 'MUTATE' in expr else expr))
PY
}

# --- M1: the exporter carries the source box's `issued` claim again ---------
cp app/export/cms.ts "$OUT/cms.ts.bak"
before=$(hash app/export/cms.ts)
python3 - <<'PY'
p='app/export/cms.ts'; s=open(p).read()
s=s.replace("    cert_state: 'none',", "    cert_state: h.certState,")
open(p,'w').write(s)
PY
echo "M1 before=$before after_edit=$(hash app/export/cms.ts)"
run M1-exporter-claims-issued app/export/cms.ts test/first-boot-tls.test.ts
cp "$OUT/cms.ts.bak" app/export/cms.ts
echo "M1 restored=$(hash app/export/cms.ts) match=$([ "$(hash app/export/cms.ts)" = "$before" ] && echo yes || echo NO)"

# --- M2: install.sh stops minting per-host pairs -----------------------------
cp tools/install_certs.mjs "$OUT/install_certs.mjs.bak"
before=$(hash tools/install_certs.mjs)
python3 - <<'PY'
p='tools/install_certs.mjs'; s=open(p).read()
s=s.replace("function mint(cn, sans, crt, key) {\n", "function mint(cn, sans, crt, key) {\n  return false; // MUTATION: no pair is minted\n")
open(p,'w').write(s)
PY
echo "M2 before=$before after_edit=$(hash tools/install_certs.mjs)"
run M2-install-mints-nothing tools/install_certs.mjs test/first-boot-tls.test.ts
cp "$OUT/install_certs.mjs.bak" tools/install_certs.mjs
echo "M2 restored=$(hash tools/install_certs.mjs) match=$([ "$(hash tools/install_certs.mjs)" = "$before" ] && echo yes || echo NO)"

# --- M3: the endpoint route is not registered --------------------------------
cp app/main.ts "$OUT/main.ts.bak"
before=$(hash app/main.ts)
python3 - <<'PY'
p='app/main.ts'; s=open(p).read()
s=s.replace("scope.all('/_plugin/*'", "scope.all('/_plugin-off/*'")
open(p,'w').write(s)
PY
echo "M3 before=$before after_edit=$(hash app/main.ts)"
run M3-no-endpoint-route app/main.ts test/plugin-host.test.ts
cp "$OUT/main.ts.bak" app/main.ts
echo "M3 restored=$(hash app/main.ts) match=$([ "$(hash app/main.ts)" = "$before" ] && echo yes || echo NO)"

# --- M4: the runner's memory ceiling is removed ------------------------------
cp docker-compose.yml "$OUT/docker-compose.yml.bak"
before=$(hash docker-compose.yml)
python3 - <<'PY'
p='docker-compose.yml'; s=open(p).read()
s=s.replace("    mem_limit: 384m\n    memswap_limit: 384m\n", "")
open(p,'w').write(s)
PY
echo "M4 before=$before after_edit=$(hash docker-compose.yml)"
run M4-no-memory-limit docker-compose.yml test/runner-memory.test.ts
cp "$OUT/docker-compose.yml.bak" docker-compose.yml
echo "M4 restored=$(hash docker-compose.yml) match=$([ "$(hash docker-compose.yml)" = "$before" ] && echo yes || echo NO)"

# --- M5: the repeat validator is disabled ------------------------------------
cp app/editor/model.ts "$OUT/model.ts.bak"
before=$(hash app/editor/model.ts)
python3 - <<'PY'
p='app/editor/model.ts'; s=open(p).read()
s=s.replace("  if (rows.length > 1) {", "  if (rows.length > 1 && false) {")
open(p,'w').write(s)
PY
echo "M5 before=$before after_edit=$(hash app/editor/model.ts)"
run M5-no-repeat-validator app/editor/model.ts test/editor-save.test.ts
cp "$OUT/model.ts.bak" app/editor/model.ts
echo "M5 restored=$(hash app/editor/model.ts) match=$([ "$(hash app/editor/model.ts)" = "$before" ] && echo yes || echo NO)"

# --- M6: uninstall forgets the registry row ---------------------------------
cp app/plugins/install.ts "$OUT/install.ts.bak"
before=$(hash app/plugins/install.ts)
python3 - <<'PY'
p='app/plugins/install.ts'; s=open(p).read()
s=s.replace("      db.prepare('DELETE FROM cms_plugin_installed WHERE plugin_id = ?').run(row.plugin_id);\n", "")
open(p,'w').write(s)
PY
echo "M6 before=$before after_edit=$(hash app/plugins/install.ts)"
run M6-uninstall-keeps-row app/plugins/install.ts test/cli-plugin.test.ts
cp "$OUT/install.ts.bak" app/plugins/install.ts
echo "M6 restored=$(hash app/plugins/install.ts) match=$([ "$(hash app/plugins/install.ts)" = "$before" ] && echo yes || echo NO)"
