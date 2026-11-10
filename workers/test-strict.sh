#!/bin/sh
set -eu
image=${1:?Pass the tested worker candidate image}
network="steel-strict-test-$$"
fixture="steel-strict-fixture-$$"
worker="steel-strict-worker-$$"
prefix=${STEEL_STRICT_TEST_PREFIX:-172.29.91}
case "$prefix" in *[!0-9.]*|'') echo 'Invalid owned test network prefix' >&2; exit 1;; esac
cleanup() { docker rm -f "$fixture" "$worker" >/dev/null 2>&1 || true; docker network rm "$network" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
docker network create --internal --subnet "${prefix}.0/24" "$network" >/dev/null
docker run -d --name "$fixture" --network "$network" --ip "${prefix}.2" --entrypoint node "$image" /app/workers/strict-fixture.mjs >/dev/null
docker run --rm --name "$worker" --user root --network "$network" --ip "${prefix}.3" \
  --cap-drop ALL --cap-add NET_ADMIN --cap-add SETUID --cap-add SETGID --cap-add SETPCAP --cap-add CHOWN \
  --security-opt no-new-privileges --shm-size 1g --entrypoint /app/workers/strict-entrypoint.sh \
  -e STEEL_STRICT_PROXY_IP="${prefix}.2" -e STEEL_STRICT_PROXY_PORT=8080 \
  -e STEEL_COORDINATOR_IP="${prefix}.2" -e STEEL_COORDINATOR_PORT=3000 \
  -v "$PWD/workers/strict-boundary.test.mjs:/app/workers/worker.mjs:ro" "$image"
