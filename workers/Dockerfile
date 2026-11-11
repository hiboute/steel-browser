# syntax=docker/dockerfile:1
FROM mcr.microsoft.com/playwright:v1.62.0-noble
WORKDIR /app/workers
COPY workers/package*.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -s /run/secrets/proxy_ca ]; then NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm ci --omit=dev; else npm ci --omit=dev; fi
COPY --chmod=644 workers/*.mjs ./
COPY --chmod=755 workers/strict-entrypoint.sh /app/workers/strict-entrypoint.sh
# When the Ubuntu mirrors of the base image cannot be reached (their names did not
# resolve from hosted runners on 2026-11-11), the same signed archive is read from
# mirrors.kernel.org instead: apt still checks the signatures.
RUN --mount=type=secret,id=proxy_ca \
    apt_get() { if [ -s /run/secrets/proxy_ca ]; then apt-get -o Acquire::https::CaInfo=/run/secrets/proxy_ca "$@"; else apt-get "$@"; fi; }; \
    install() { apt_get update && apt_get install -y --no-install-recommends iptables util-linux; }; \
    { install || { echo "Ubuntu mirrors unreachable, retrying with mirrors.kernel.org"; \
        find /etc/apt \( -name '*.list' -o -name '*.sources' \) -type f -exec sed -i -E 's#https?://([a-z0-9.-]+\.)?(archive|security)\.ubuntu\.com/ubuntu#http://mirrors.kernel.org/ubuntu#g' {} + ; \
        install; }; } \
    && rm -rf /var/lib/apt/lists/*
ENV STEEL_WORKER_STATE_DIR=/state
VOLUME /state
USER pwuser
ENTRYPOINT ["node", "/app/workers/worker.mjs"]
