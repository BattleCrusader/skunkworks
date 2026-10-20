#!/usr/bin/env bash
# QA round 2 — reproduce the 4 GiB hoard against the shipped ceiling, by hand.
set -u
cd /Volumes/Backup/Development/skunkworks
W=$(mktemp -d "${TMPDIR:-/tmp}/skw-qa2-mem.XXXX")
NAME=qa2-memhoard
mkdir -p "$W/plugins" "$W/run" "$W/scratch"
cp -R test/fixtures/plugins/memhoard "$W/plugins/memhoard"
cp test/fixtures/runner_client.mjs "$W/client.mjs"
chmod 777 "$W/run" "$W/scratch"

docker rm -f $NAME >/dev/null 2>&1
docker build -q -t skw-runner:qa2 runner > "$W/build.log" 2>&1 || { echo "BUILD FAILED"; tail -5 "$W/build.log"; exit 1; }

docker run -d --name $NAME \
  --network none --read-only --cap-drop ALL --pids-limit 64 \
  --memory 384m --memory-swap 384m --security-opt no-new-privileges:true --tmpfs /tmp \
  -e SKW_RUNNER_MEMORY_MB=384 \
  -v "$W/plugins":/srv/plugins:ro -v "$W/run":/srv/run -v "$W/scratch":/srv/scratch \
  -v "$W/client.mjs":/srv/client.mjs:ro skw-runner:qa2 >/dev/null

# wait for ready
for i in $(seq 1 60); do
  OUT=$(docker exec $NAME node /srv/client.mjs '{"id":1,"op":"plugin.list"}' 2>/dev/null || true)
  echo "$OUT" | grep -q '"ready":true' && break
  sleep 0.25
done

echo "=== limits, from the container ==="
docker inspect -f 'Memory={{.HostConfig.Memory}} MemorySwap={{.HostConfig.MemorySwap}} PidsLimit={{.HostConfig.PidsLimit}}' $NAME
docker exec $NAME node -e "process.stdout.write('memory.max='+require('node:fs').readFileSync('/sys/fs/cgroup/memory.max','utf8'))"
echo
echo "=== idle ==="; docker stats --no-stream --format '{{.MemUsage}}' $NAME
echo "=== a package asks for 4096 MiB (granted=[] on the wire) ==="
docker exec $NAME node /srv/client.mjs '{"id":1,"op":"plugin.invoke","plugin":"memhoard","tenant":"acme","granted":[],"granted_host":[],"args":{"op":"hold","args":{"mb":4096}}}'
echo "=== the cgroup's high-water mark ==="
docker exec $NAME node -e "process.stdout.write('memory.peak='+require('node:fs').readFileSync('/sys/fs/cgroup/memory.peak','utf8'))"
echo
echo "=== the container survived? ==="
docker inspect -f 'Running={{.State.Running}} OOMKilled={{.State.OOMKilled}} ExitCode={{.State.ExitCode}}' $NAME
echo "=== the same package answers again 250 ms later ==="
sleep 0.25
docker exec $NAME node /srv/client.mjs '{"id":2,"op":"plugin.invoke","plugin":"memhoard","tenant":"acme","granted":[],"args":{"op":"hold","args":{"mb":8}}}'
echo "=== and a JS-object hoard ==="
docker exec $NAME node /srv/client.mjs '{"id":3,"op":"plugin.invoke","plugin":"memhoard","tenant":"acme","granted":[],"args":{"op":"holdObjects","args":{"mb":512}}}'
echo "=== runner log (last 8 lines) ==="
docker logs $NAME 2>&1 | tail -8
docker rm -f $NAME >/dev/null 2>&1
rm -rf "$W"
