# Builds `cashwebd-exe` (the single cashweb/registry binary -- see PLAN.md constraint 6: one
# binary, route groups rather than separate services). Build context must be the repository root:
# `cashweb`'s crates depend on the sibling `bitcoinsuite`, and `cashweb-config` compiles the shared
# protocol registry under `docs/` into the binary.
#
# gcc-12/g++-12 pinned to match `.github/workflows/backend-ci.yml`'s own fix: `librocksdb-sys`'s
# vendored RocksDB 7.4.4 C++ source doesn't compile under newer default GCC (verified during that
# ticket: a compiler-version incompatibility, not a corrupt dependency) -- rather than bumping
# rocksdb itself (a much larger change), both CI and this image pin gcc-12.
FROM rust:1-bookworm AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc-12 g++-12 \
    && rm -rf /var/lib/apt/lists/*
ENV CC=gcc-12
ENV CXX=g++-12

WORKDIR /build
COPY backend/bitcoinsuite ./bitcoinsuite
COPY backend/cashweb ./cashweb
COPY docs ./docs

WORKDIR /build/cashweb
RUN cargo build --release -p cashwebd-exe

# Slim runtime image: just the compiled binary, no Rust toolchain.
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/cashweb/target/release/cashwebd-exe /usr/local/bin/cashwebd-exe

# Config is static (see docker/cashwebd.toml's own header comment for why it needs no
# templating/secrets) -- the genuinely-variable, secret-bearing config (the real Alchemy RPC URL,
# burn address, network tag) flows entirely through env vars read lazily at request time by
# `cashweb-registry`'s own `OnceLock`-based gate configs (`http/monad_message.rs`,
# `http/monad_topics.rs`, `network_tag.rs`), set via docker-compose's `environment:`, not through
# this file.
COPY backend/docker/cashwebd.toml /etc/cashwebd/cashwebd.toml

VOLUME ["/data"]
EXPOSE 8080

ENTRYPOINT ["cashwebd-exe", "/etc/cashwebd/cashwebd.toml"]
