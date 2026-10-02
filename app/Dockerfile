# Builds the Quasar SPA and serves it as static files via nginx.
#
# Ticket #53 (package split): build context is now the *repo root* (see docker-compose.yml --
# `context: .`, `dockerfile: app/Dockerfile`), not `app/` -- app/ is a yarn workspace member now,
# and needs the root package.json/yarn.lock plus every sibling `packages/*` (including the
# promoted-from-app/local_modules/ `bn.js`/`bitcore-lib-xpi`) to install at all.
#
# python3/make/g++ are installed defensively for native-addon deps that may need to compile from
# source (this app's dependency tree still carries several old crypto/browserify-family packages
# via bitcore-lib-xpi, see PLAN.md's bn.js/local_modules notes) -- cheap to include, expensive to
# find out mid-build that they were missing.
FROM node:24-bookworm AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY package.json yarn.lock ./
COPY app/package.json app/package.json
COPY packages/cashweb/package.json packages/cashweb/package.json
COPY packages/wallet/package.json packages/wallet/package.json
COPY packages/bot/package.json packages/bot/package.json
COPY packages/bn.js/package.json packages/bn.js/package.json
COPY packages/bitcore-lib-xpi/package.json packages/bitcore-lib-xpi/package.json
RUN yarn install --frozen-lockfile

COPY . .

# Ticket #54: Quasar's own `QCLI_`-prefixed env var convention (confirmed live -- see that
# ticket's commit) is what actually reaches `import.meta.env` in the built bundle. The SPA gets
# only the public relay URL and shared chain identifier; the secret-bearing upstream RPC URL is a
# backend runtime variable and must never be copied into this image or its static JavaScript.
ARG QCLI_MONAD_RELAY_BASE_URL
ARG QCLI_MONAD_RPC_CHAIN
ARG QCLI_MONAD_STAMP_BURN_ADDRESS
ARG QCLI_CASHWEB_STAMP_MIN_BURN_VALUE_WEI
ENV QCLI_MONAD_RELAY_BASE_URL=${QCLI_MONAD_RELAY_BASE_URL}
ENV QCLI_MONAD_RPC_CHAIN=${QCLI_MONAD_RPC_CHAIN}
ENV QCLI_MONAD_STAMP_BURN_ADDRESS=${QCLI_MONAD_STAMP_BURN_ADDRESS}
ENV QCLI_CASHWEB_STAMP_MIN_BURN_VALUE_WEI=${QCLI_CASHWEB_STAMP_MIN_BURN_VALUE_WEI}

WORKDIR /build/app
# Explicit `-m spa`: `package.json`'s own `build` script targets electron (`-m electron -b
# builder`, for desktop packaging) -- this demo needs the plain browser SPA build instead, output
# to the framework default `dist/spa`.
RUN npx quasar build -m spa

FROM nginx:1.27-alpine
COPY --from=builder /build/app/dist/spa /usr/share/nginx/html
COPY app/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
