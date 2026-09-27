# Builds the Quasar SPA and serves it as static files via nginx. Build context is `app/` (this
# directory).
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
COPY local_modules ./local_modules
RUN yarn install --frozen-lockfile

COPY . .

# Real Alchemy/relay config baked into the bundle at build time (see quasar.conf.js's `build.env`
# comment: webpack's DefinePlugin only substitutes what's explicitly listed there, so these must be
# real env vars *at this build step*, not just present in some `.env` file nothing here reads).
# Passed through as build ARGs from docker-compose.yml rather than hardcoded, since the real values
# (a real Alchemy API key) are secrets that must come from the environment, never committed.
ARG MONAD_TESTNET_HTTP_RPC_URL
ARG MONAD_RELAY_BASE_URL
ARG MONAD_STAMP_BURN_ADDRESS
ARG CASHWEB_STAMP_MIN_BURN_VALUE_WEI
ENV MONAD_TESTNET_HTTP_RPC_URL=${MONAD_TESTNET_HTTP_RPC_URL}
ENV MONAD_RELAY_BASE_URL=${MONAD_RELAY_BASE_URL}
ENV MONAD_STAMP_BURN_ADDRESS=${MONAD_STAMP_BURN_ADDRESS}
ENV CASHWEB_STAMP_MIN_BURN_VALUE_WEI=${CASHWEB_STAMP_MIN_BURN_VALUE_WEI}

# Explicit `-m spa`: `package.json`'s own `build` script targets electron (`-m electron -b
# builder`, for desktop packaging) -- this demo needs the plain browser SPA build instead, output
# to the framework default `dist/spa`.
RUN npx quasar build -m spa

FROM nginx:1.27-alpine
COPY --from=builder /build/dist/spa /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
