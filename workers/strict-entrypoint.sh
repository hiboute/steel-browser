#!/bin/sh
set -eu
# This runs only in the dedicated worker's network namespace, never on the host.
# No DNS, IPv6, UDP, or arbitrary direct TCP remains after the rules are installed.
case "${STEEL_STRICT_PROXY_IP:-}:${STEEL_COORDINATOR_IP:-}" in *[!0-9.:]*|'':*) echo 'Literal IPv4 endpoints are required' >&2; exit 1;; esac
case "${STEEL_STRICT_PROXY_PORT:-}:${STEEL_COORDINATOR_PORT:-}" in *[!0-9:]*|:*) echo 'Numeric endpoint ports are required' >&2; exit 1;; esac
node --input-type=module -e 'import{isIP}from"node:net";for(const k of["STEEL_STRICT_PROXY_IP","STEEL_COORDINATOR_IP"])if(isIP(process.env[k])!==4)process.exit(1);for(const k of["STEEL_STRICT_PROXY_PORT","STEEL_COORDINATOR_PORT"]){const p=Number(process.env[k]);if(!Number.isInteger(p)||p<1||p>65535)process.exit(1)}'
iptables -w -P OUTPUT DROP
iptables -w -F OUTPUT
iptables -w -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -w -A OUTPUT -o lo -p tcp -j ACCEPT
iptables -w -A OUTPUT -p tcp -d "$STEEL_STRICT_PROXY_IP" --dport "$STEEL_STRICT_PROXY_PORT" -j ACCEPT
iptables -w -A OUTPUT -p tcp -d "$STEEL_COORDINATOR_IP" --dport "$STEEL_COORDINATOR_PORT" -j ACCEPT
ip6tables -w -P OUTPUT DROP
ip6tables -w -F OUTPUT
mkdir -p /run/steel /state
chmod 0755 /run/steel
chown 1000:1000 /state
node --input-type=module -e 'import{writeFileSync}from"node:fs";writeFileSync("/run/steel/strict-egress.json",JSON.stringify({version:1,boundary:"linux-output-firewall",proxyHost:process.env.STEEL_STRICT_PROXY_IP,proxyPort:Number(process.env.STEEL_STRICT_PROXY_PORT),uid:1000,ipv6:"blocked",dns:"blocked"}),{mode:0o644})'
export STEEL_WORKER_STRICT=true
export STEEL_WORKER_STATE_DIR=/state
# setpriv changes credentials but retains root's HOME. Firefox/WebKit need the
# target user's writable cache/config home, without restoring any capabilities.
worker_user_home=$(getent passwd 1000 | cut -d: -f6)
test -n "$worker_user_home" && test "$worker_user_home" != /root && test -d "$worker_user_home"
exec setpriv --reuid=1000 --regid=1000 --init-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs env HOME="$worker_user_home" node /app/workers/worker.mjs
