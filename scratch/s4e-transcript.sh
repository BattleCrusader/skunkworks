#!/usr/bin/env bash
# S4e evidence transcript: cold bundle -> install -> compose up -> HTTPS -> plugin invocation
# -> uninstall. Real output, captured to scratch/s4e-transcript.txt. Not a gate.
set -uo pipefail
cd /Volumes/Backup/Development/skunkworks
W=$(mktemp -d /tmp/s4e-transcript.XXXX)
export W
PROJECT=skw-s4e-demo
HTTPS=19444
HTTP=19081

echo "### 1. cut a CMS bundle from a tenant whose control plane says issued"
node --input-type=module - <<'EOF'
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runExport } from './app/export/index.ts';
import { openAdminWrite } from './app/db/classes.ts';
import { makeFixture, REPO } from './test/helpers/fixture.ts';

const W = process.env.W;
const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test', 'www.acme.test'] }] });
const control = new Database(fixture.controlDb);
control.prepare("UPDATE domain SET cert_state='issued'").run();
control.close();
const db = openAdminWrite(fixture.sitePath('acme'), 5000);
const r = runExport({
  target: 'cms', db, tenantKey: 'acme', out: join(W, 'bundle'),
  exportNow: '2026-10-21T00:00:00.000Z', contentRoot: join(fixture.dir, 'content'),
  repoRoot: REPO, tmpDir: fixture.dir, origin: 'https://acme.test',
  tenant: { key: 'acme', mode: 'production', status: 'active', displayName: 'Acme', dbVersion: 3,
    hosts: [{ host: 'acme.test', kind: 'primary', isPrimary: 1, certState: 'issued' },
            { host: 'www.acme.test', kind: 'alias', isPrimary: 0, certState: 'issued' }] },
});
db.close();
if (!r.ok) { console.error(r.refusals); process.exit(1); }
writeFileSync(join(W, 'fixture.txt'), fixture.dir);
console.log('export: ok, bundle at', join(W, 'bundle'));
EOF
SRC=$(cat $W/fixture.txt)
echo
echo "### 2. the seed the bundle carries (the claim), and the certificates it ships"
python3 -c "import json,sys;d=json.load(open('$W/bundle/data/control.seed.json'));print(json.dumps(d['tenants'][0]['hosts'],indent=1))"
echo "cert files in the bundle: $(find $W/bundle -name '*.crt' -o -name '*.key' | wc -l | tr -d ' ')"
grep -E "listen|ssl_certificate|acme-challenge" $W/bundle/nginx/conf.d/10-app.conf | head -6

echo
echo "### 3. install.sh into an empty directory (no --no-compose path here; compose follows)"
cp -R $W/bundle $W/site
cat > $W/site/compose.gate.yml <<YML
services:
  nginx:
    ports: !override
      - "${HTTP}:80"
      - "${HTTPS}:443"
    networks:
      default:
        aliases: [acme.test, www.acme.test]
  app:
    image: skw-app:s4d
    user: "$(id -u):$(id -g)"
    volumes:
      - /Volumes/Backup/Development/skunkworks/dist:/srv/app/dist:ro
  plugin-runner:
    image: skw-runner:s4e
  acme:
    image: skw-acme:s4e
YML
SKW_ENV_FILE=$W/site/.env $W/site/install.sh --bundle $W/site --target $W/site/data --runtime /Volumes/Backup/Development/skunkworks --no-compose 2>&1 | sed -n '1,40p'

echo
echo "### 4. the pairs install.sh wrote (the files nginx names)"
ls -l $W/site/data/certs

echo
echo "### 5. docker compose up (no CA reachable: acme must claim nothing)"
(cd $W/site && SKW_ACME_DIRECTORY=http://127.0.0.1:9/dir docker compose -p $PROJECT -f docker-compose.yml -f compose.gate.yml up -d 2>&1 | tail -8)
for i in $(seq 1 60); do
  code=$(curl -sk -o /dev/null -w '%{http_code}' --resolve acme.test:$HTTPS:127.0.0.1 https://acme.test:$HTTPS/pricing || true)
  [ "$code" = "200" ] && break
  sleep 1
done
echo "compose ps:"; (cd $W/site && docker compose -p $PROJECT ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}')

echo
echo "### 6. HTTPS GET /pricing, and the certificate that answered"
curl -sk --resolve acme.test:$HTTPS:127.0.0.1 -D - https://acme.test:$HTTPS/pricing -o /tmp/s4e-page.html | sed -n '1,6p'
echo "--- body ---"; cat /tmp/s4e-page.html
echo "--- certificate ---"
openssl s_client -connect 127.0.0.1:$HTTPS -servername acme.test -showcerts </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates 2>&1 | sed -n '1,6p'
echo "SAN: $(openssl s_client -connect 127.0.0.1:$HTTPS -servername acme.test -showcerts </dev/null 2>/dev/null | openssl x509 -noout -text 2>/dev/null | grep -A1 'Subject Alternative' | tail -1 | tr -d ' ')"
echo "--- cert_state in the installed control plane ---"
node --no-warnings -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('$W/site/data/control.db');console.log(d.prepare('select host,cert_state from domain').all())"
echo "--- acme log ---"; (cd $W/site && docker compose -p $PROJECT logs --no-color acme 2>&1 | tail -3)

echo
echo "### 7. a plugin, through the product's public endpoint (D25)"
node --input-type=module - <<'EOF'
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageRootHash } from './app/plugins/protocol.ts';
const W = process.env.W;
const root = packageRootHash('test/fixtures/plugins/notes').root;
writeFileSync(join(W, 'notes-report.json'), JSON.stringify({ plugin: 'notes', version: '1.0.0', root_hash: root, runner_image_digest: 'sha256:transcript', ran_at: '2026-10-21T00:00:00.000Z' }));
EOF
SKW_DATA_DIR=$W/site/data node dist/app/cli/skwctl.js plugin install test/fixtures/plugins/notes --tenant acme --test-report $W/notes-report.json --runner-digest sha256:transcript --enable
(cd $W/site && docker compose -p $PROJECT restart plugin-runner >/dev/null 2>&1)
sleep 3
echo "--- POST /_plugin/notes/sign (the package writes through the host) ---"
curl -sk --resolve acme.test:$HTTPS:127.0.0.1 -X POST --data 'signed-by-a-request' -H 'content-type: text/plain' https://acme.test:$HTTPS/_plugin/notes/sign; echo
echo "--- GET /_plugin/notes/list (the host answers the package's store.query) ---"
curl -sk --resolve acme.test:$HTTPS:127.0.0.1 https://acme.test:$HTTPS/_plugin/notes/list; echo
echo "--- the row the plugin wrote, read from site.db ---"
node --no-warnings -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('$W/site/data/tenants/acme/site.db');console.log(d.prepare(\"select key,value_json from cms_plugin_setting where plugin_id='notes'\").all())"

echo
echo "### 8. uninstall: archive, drop, and the URL that stops existing"
SKW_DATA_DIR=$W/site/data node dist/app/cli/skwctl.js plugin uninstall notes --tenant acme --archive-dir $W/site/data/plugin-archive
echo "--- archive ---"; ARCH=$(ls $W/site/data/plugin-archive/*.json | head -1); ls -l $ARCH; python3 -c "import json;d=json.load(open('$ARCH'));print('format',d['format'],'plugin',d['plugin'],'tables',[(t['name'],len(t['rows'])) for t in d['tables']],'settings',[s['key'] for s in d['settings']])"
echo "--- rows left behind ---"
node --no-warnings -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('$W/site/data/tenants/acme/site.db');console.log({installed:d.prepare('select count(*) n from cms_plugin_installed').get().n, registry:d.prepare('select count(*) n from cms_table_registry where plugin_id=?').get('notes').n, table:d.prepare(\"select count(*) n from sqlite_master where name='p_notes_note'\").get().n})"
curl -sk -o /dev/null -w 'GET /_plugin/notes/list after uninstall: %{http_code}\n' --resolve acme.test:$HTTPS:127.0.0.1 https://acme.test:$HTTPS/_plugin/notes/list

echo
echo "### 9. teardown"
(cd $W/site && docker compose -p $PROJECT down -v --remove-orphans >/dev/null 2>&1)
docker network rm ${PROJECT}_default >/dev/null 2>&1
echo "W=$W (kept for inspection)"

echo
echo "### 10. runner memory: the ceiling, the peak, and the refusal"
W2=$(mktemp -d /tmp/s4e-mem.XXXX); mkdir -p $W2/plugins $W2/run $W2/scratch
cp -R test/fixtures/plugins/memhoard $W2/plugins/; cp test/fixtures/runner_client.mjs $W2/client.mjs
chmod 777 $W2/run $W2/scratch
docker rm -f s4e-mem >/dev/null 2>&1
docker run -d --name s4e-mem --network none --read-only --cap-drop ALL --pids-limit 64 --memory 384m --memory-swap 384m --tmpfs /tmp \
  -e SKW_RUNNER_MEMORY_MB=384 -v $W2/plugins:/srv/plugins:ro -v $W2/run:/srv/run -v $W2/scratch:/srv/scratch -v $W2/client.mjs:/srv/client.mjs:ro skw-runner:s4e >/dev/null
sleep 2
echo "-- docker inspect limits --"; docker inspect -f 'Memory={{.HostConfig.Memory}} MemorySwap={{.HostConfig.MemorySwap}} PidsLimit={{.HostConfig.PidsLimit}}' s4e-mem
echo "-- inside the container --"; docker exec s4e-mem node -e "process.stdout.write('memory.max=' + require('node:fs').readFileSync('/sys/fs/cgroup/memory.max','utf8') + '\n')"
echo "-- idle RSS --"; docker stats --no-stream --format '{{.MemUsage}} ({{.MemPerc}})' s4e-mem
echo "-- a package asks for 4096 MiB --"
docker exec s4e-mem node /srv/client.mjs '{"id":1,"op":"plugin.invoke","plugin":"memhoard","tenant":"acme","args":{"op":"hold","args":{"mb":4096}}}'
echo "-- peak after the kill --"; docker exec s4e-mem node -e "process.stdout.write('memory.peak=' + (Number(require('node:fs').readFileSync('/sys/fs/cgroup/memory.peak','utf8'))/(1024*1024)).toFixed(1) + ' MiB\n')"
echo "-- container and host --"; docker inspect -f 'Running={{.State.Running}} OOMKilled(container)={{.State.OOMKilled}}' s4e-mem
echo "-- the same package answers again 250 ms later (restart) --"; sleep 1
docker exec s4e-mem node /srv/client.mjs '{"id":2,"op":"plugin.invoke","plugin":"memhoard","tenant":"acme","args":{"op":"hold","args":{"mb":8}}}'
echo "-- a JS-object hoard is stopped by the child's heap cap --"
docker exec s4e-mem node /srv/client.mjs '{"id":3,"op":"plugin.invoke","plugin":"memhoard","tenant":"acme","args":{"op":"holdObjects","args":{"mb":512}}}'
docker rm -f s4e-mem >/dev/null 2>&1; rm -rf $W2
