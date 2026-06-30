# syntax=docker/dockerfile:1
# Custom Caddy with the caddy-security (AuthCrunch) plugin baked in.
# Pin both Caddy and the plugin for reproducibility. caddy-security@v1.1.64
# requires caddy/v2 v2.11.4 (and Go >= 1.25.8 to build).
FROM caddy:2.11.4-builder AS builder
# GOTOOLCHAIN=auto lets the build fetch the Go toolchain the plugin needs.
ENV GOTOOLCHAIN=auto
RUN xcaddy build v2.11.4 \
    --with github.com/greenpau/caddy-security@v1.1.64

FROM caddy:2.11.4
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
