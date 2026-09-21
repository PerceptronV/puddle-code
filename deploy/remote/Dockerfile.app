FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /build
COPY . .
RUN pnpm install --frozen-lockfile --filter @puddle/web...
ARG PUDDLE_REMOTE_SERVICE
ENV VITE_PUDDLE_REMOTE_SERVICE=$PUDDLE_REMOTE_SERVICE
RUN test -n "$VITE_PUDDLE_REMOTE_SERVICE" && pnpm --filter @puddle/shared build && pnpm --filter @puddle/remote-transport build && pnpm --filter @puddle/web build
# The first-paint theme script is external so script-src needs no inline exception.
RUN node deploy/remote/externalise-theme.mjs packages/web/dist

FROM caddy:2-alpine
COPY --from=build /build/packages/web/dist /srv
COPY --chmod=644 deploy/remote/Caddyfile.app /etc/caddy/Caddyfile
# Public assets can retain private checkout permissions when Vite copies them.
# Port 8080 needs no privileged-port capability; it conflicts with cap_drop: ALL.
RUN chmod -R a+rX /srv && setcap -r /usr/bin/caddy
EXPOSE 8080
