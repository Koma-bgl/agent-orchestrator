# syntax=docker/dockerfile:1
# Fleet SSO portal: caddy-security authentication portal, deployed to Cloud Run
# via `gcloud run deploy --source` (Cloud Build) — so this image is fully
# self-contained (no dependence on locally-built images).
# caddy-security pinned to v1.1.31: v1.1.32+ has a regression (#471) that deletes
# the access_token cookie right after login → cross-subdomain SSO redirect loop.
ARG CADDY_SECURITY_VERSION=v1.1.31
FROM caddy:2.11.4-builder AS builder
ARG CADDY_SECURITY_VERSION
RUN xcaddy build v2.11.4 \
    --with github.com/greenpau/caddy-security@${CADDY_SECURITY_VERSION}

FROM caddy:2.11.4
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile.portal /etc/caddy/Caddyfile
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
