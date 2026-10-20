#!/usr/bin/env bash
# S4f item 1 — the trust surface, as an operator meets it. Real commands, real output.
#
# This is a transcript, not a gate (a gate is `test/plugin-trust.test.ts`). It exists so the
# four proofs in the report are quotable from one run: a signed install, an edited package,
# an unsigned package with and without the flag, and a key mismatch.
set -eu
cd "$(dirname "$0")/../.." || exit 1
ROOT=$PWD
W=scratch/s4f/live
rm -rf "$W"
mkdir -p "$W"

export SKW_DATA_DIR="$W/data"
export SKW_EDGE_TOKEN="transcript-edge-token-0123456789"
export SKW_SESSION_KEY="transcript-session-key-0123456789"
export SKW_DOWNLOAD_TOKEN_KEY="transcript-download-key-0123456789"
export SKW_IP_HASH_KEY="transcript-ip-hash-key-0123456789"
export SKW_ADMIN_ORIGIN="https://admin.skw.test"
export SKW_BUILD_ID="s4f-transcript"
mkdir -p "$SKW_DATA_DIR/tenants/acme"

node -e '
const Database = require("better-sqlite3");
const fs = require("node:fs");
const db = new Database(process.env.SKW_DATA_DIR + "/tenants/acme/site.db");
db.exec(fs.readFileSync("schema/site.sql", "utf8"));
db.close();
'

echo '### 1. two publisher keypairs, and the fingerprint of each'
node tools/plugin_sign.ts --keygen --out "$W/pubA"
node tools/plugin_sign.ts --keygen --out "$W/pubB"
echo
echo '### 2. a package, signed by A'
cp -R test/fixtures/plugins/notes "$W/package"
node tools/plugin_sign.ts --dir "$W/package" --key "$W/pubA.key" --publisher acme-labs --out "$W/notes-1.0.0.sig.json"
node -e '
const { packageRootHash } = require("./app/plugins/protocol.ts");
' 2>/dev/null || true
ROOT_HASH=$(node -e '
import("./app/plugins/protocol.ts").then(({ packageRootHash }) => {
  process.stdout.write(packageRootHash(process.argv[1]).root);
});
' "$W/package")
node -e '
const root = process.argv[1];
require("node:fs").writeFileSync(process.argv[2], JSON.stringify({
  plugin: "notes", version: "1.0.0", root_hash: root,
  runner_image_digest: "sha256:live", ran_at: "2026-10-21T00:00:00.000Z"
}, null, 2) + "\n");
' "$ROOT_HASH" "$W/report.json"
echo "root_hash=$ROOT_HASH"
echo
echo '### 3. the tenant owner imports A, and the store is 0600'
node app/cli/skwctl.ts plugin trust import "$W/pubA.pub" --publisher acme-labs --tenant acme
ls -l "$W/data/trust/publishers.json" | awk '{print $1, $NF}'
node app/cli/skwctl.ts plugin trust list --tenant acme
echo
echo '### 4. install with --signature: the screen, then the install'
node app/cli/skwctl.ts plugin install "$W/package" --tenant acme \
  --signature "$W/notes-1.0.0.sig.json" --test-report "$W/report.json" \
  --runner-digest sha256:live --enable
echo
echo '### 5. one byte more in index.mjs: refused, naming the file'
cp -R test/fixtures/plugins/notes "$W/edited"
node tools/plugin_sign.ts --dir "$W/edited" --key "$W/pubA.key" --publisher acme-labs --out "$W/edited.sig.json" >/dev/null
printf '\n// edited after signing\n' >> "$W/edited/index.mjs"
EDIT_ROOT=$(node -e 'import("./app/plugins/protocol.ts").then(({packageRootHash}) => process.stdout.write(packageRootHash(process.argv[1]).root))' "$W/edited")
node -e '
require("node:fs").writeFileSync(process.argv[2], JSON.stringify({
  plugin: "notes", version: "1.0.0", root_hash: process.argv[1],
  runner_image_digest: "sha256:live", ran_at: "2026-10-21T00:00:00.000Z"
}) + "\n");
' "$EDIT_ROOT" "$W/edited-report.json"
set +e
node app/cli/skwctl.ts plugin install "$W/edited" --tenant acme \
  --signature "$W/edited.sig.json" --test-report "$W/edited-report.json" --runner-digest sha256:live
echo "exit=$?"
echo
echo '### 6. unsigned: refused without the flag, installed with it'
cp -R test/fixtures/plugins/echo "$W/unsigned"
UNSIGNED_ROOT=$(node -e 'import("./app/plugins/protocol.ts").then(({packageRootHash}) => process.stdout.write(packageRootHash(process.argv[1]).root))' "$W/unsigned")
node -e '
require("node:fs").writeFileSync(process.argv[2], JSON.stringify({
  plugin: "echo", version: process.argv[3], root_hash: process.argv[1],
  runner_image_digest: "sha256:live", ran_at: "2026-10-21T00:00:00.000Z"
}) + "\n");
' "$UNSIGNED_ROOT" "$W/unsigned-report.json" "$(node -p 'require("./test/fixtures/plugins/echo/plugin.json").version')"
node app/cli/skwctl.ts plugin install "$W/unsigned" --tenant acme \
  --test-report "$W/unsigned-report.json" --runner-digest sha256:live
echo "exit=$?"
echo '--- with --allow-unsigned ---'
node app/cli/skwctl.ts plugin install "$W/unsigned" --tenant acme \
  --test-report "$W/unsigned-report.json" --runner-digest sha256:live --allow-unsigned --enable
echo "exit=$?"
echo
echo '### 7. a package signed by B, while A is the imported key: both fingerprints'
cp -R test/fixtures/plugins/notes "$W/mismatch"
node tools/plugin_sign.ts --dir "$W/mismatch" --key "$W/pubB.key" --publisher acme-labs --out "$W/mismatch.sig.json" >/dev/null
MIS_ROOT=$(node -e 'import("./app/plugins/protocol.ts").then(({packageRootHash}) => process.stdout.write(packageRootHash(process.argv[1]).root))' "$W/mismatch")
node -e '
require("node:fs").writeFileSync(process.argv[2], JSON.stringify({
  plugin: "notes", version: "1.0.0", root_hash: process.argv[1],
  runner_image_digest: "sha256:live", ran_at: "2026-10-21T00:00:00.000Z"
}) + "\n");
' "$MIS_ROOT" "$W/mismatch-report.json"
node app/cli/skwctl.ts plugin install "$W/mismatch" --tenant acme \
  --signature "$W/mismatch.sig.json" --test-report "$W/mismatch-report.json" --runner-digest sha256:live
echo "exit=$?"
set -e
echo
echo '### 8. the rows, and the audit entry for the unsigned install'
node -e '
const Database = require("better-sqlite3");
const db = new Database(process.env.SKW_DATA_DIR + "/tenants/acme/site.db", { readonly: true });
for (const row of db.prepare("SELECT plugin_id, version, publisher, publisher_key_fingerprint, signature_state, enabled FROM cms_plugin_installed ORDER BY id").all()) {
  console.log(JSON.stringify(row));
}
const audit = db.prepare("SELECT action, target_id, after_json FROM cms_audit WHERE action = ? ORDER BY id").all("plugin.install");
for (const row of audit) console.log("audit:", row.action, row.target_id, row.after_json);
db.close();
'
echo
echo '### 9. a package that is not installed cannot be enabled'
node app/cli/skwctl.ts plugin list --tenant acme
