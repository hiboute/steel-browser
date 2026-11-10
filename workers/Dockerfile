# syntax=docker/dockerfile:1
FROM mcr.microsoft.com/playwright:v1.62.0-noble
WORKDIR /app/workers
COPY workers/package*.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -s /run/secrets/proxy_ca ]; then NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm ci --omit=dev; else npm ci --omit=dev; fi
COPY --chmod=644 workers/*.mjs ./
COPY --chmod=755 workers/strict-entrypoint.sh /app/workers/strict-entrypoint.sh
RUN --mount=type=secret,id=proxy_ca \
    if [ -s /run/secrets/proxy_ca ]; then apt-get -o Acquire::https::CaInfo=/run/secrets/proxy_ca update; else apt-get update; fi \
    && apt-get install -y --no-install-recommends iptables util-linux && rm -rf /var/lib/apt/lists/*
ENV STEEL_WORKER_STATE_DIR=/state
VOLUME /state
USER pwuser
ENTRYPOINT ["node", "/app/workers/worker.mjs"]
