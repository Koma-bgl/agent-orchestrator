# syntax=docker/dockerfile:1
# Fleet SSO portal: caddy-security authentication portal, deployed to Cloud Run
# via `gcloud run deploy --source` (Cloud Build) — so this image is fully
# self-contained (no dependence on locally-built images).
FROM caddy:2.11.4-builder AS builder
RUN xcaddy build v2.11.4 \
    --with github.com/greenpau/caddy-security@v1.1.64

FROM caddy:2.11.4
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile.portal /etc/caddy/Caddyfile
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
