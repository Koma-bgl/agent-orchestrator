# syntax=docker/dockerfile:1
# Custom Caddy with the caddy-security (AuthCrunch) plugin baked in.
# Pinned to v1.1.31: v1.1.32+ regressions break cross-subdomain SSO — #471
# (deletes the access_token cookie after login) and #481 (`cookie domain` no
# longer scopes the token cookie). 1.1.31 predates both.
ARG CADDY_SECURITY_VERSION=v1.1.31
FROM caddy:2.11.4-builder AS builder
ARG CADDY_SECURITY_VERSION
# GOTOOLCHAIN=auto lets the build fetch the Go toolchain the plugin needs.
ENV GOTOOLCHAIN=auto
RUN xcaddy build v2.11.4 \
    --with github.com/greenpau/caddy-security@${CADDY_SECURITY_VERSION}

FROM caddy:2.11.4
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
