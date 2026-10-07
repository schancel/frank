# Builds and runs the Frank Email Gateway daemon
# Context must be the repository root because packages/mail-gateway depends on sibling monorepo packages.
FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy root workspace manifests
COPY package.json yarn.lock tsconfig.base.json ./

# Copy package manifests for workspace linking
COPY packages/account-recovery/package.json packages/account-recovery/package.json
COPY packages/account-vault/package.json packages/account-vault/package.json
COPY packages/adaptor-signatures/package.json packages/adaptor-signatures/package.json
COPY packages/bitcore-lib-xpi/package.json packages/bitcore-lib-xpi/package.json
COPY packages/bn.js/package.json packages/bn.js/package.json
COPY packages/bot/package.json packages/bot/package.json
COPY packages/cashweb/package.json packages/cashweb/package.json
COPY packages/codex32/package.json packages/codex32/package.json
COPY packages/crypto-box/package.json packages/crypto-box/package.json
COPY packages/directory-admission/package.json packages/directory-admission/package.json
COPY packages/domain-roots/package.json packages/domain-roots/package.json
COPY packages/frank-codec/package.json packages/frank-codec/package.json
COPY packages/nakamoto/package.json packages/nakamoto/package.json
COPY packages/role-keys/package.json packages/role-keys/package.json
COPY packages/swap-protocol/package.json packages/swap-protocol/package.json
COPY packages/wallet/package.json packages/wallet/package.json
COPY packages/mail-gateway/package.json packages/mail-gateway/package.json

RUN yarn install --frozen-lockfile

# Copy source tree
COPY . .

WORKDIR /build/packages/mail-gateway

VOLUME ["/data"]

EXPOSE 2525 8082

CMD ["yarn", "start"]
