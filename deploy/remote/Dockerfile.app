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
COPY deploy/remote/Caddyfile.app /etc/caddy/Caddyfile
EXPOSE 8080
