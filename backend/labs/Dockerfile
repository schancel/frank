# Local component contracts share the production daemon's sources, not its deployment config.
FROM rust:1-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends gcc-12 g++-12 libclang-dev protobuf-compiler python3 && rm -rf /var/lib/apt/lists/*
ENV CC=gcc-12 CXX=g++-12 CARGO_BUILD_JOBS=2
WORKDIR /build
COPY backend/bitcoinsuite backend/bitcoinsuite
COPY backend/cashweb backend/cashweb
COPY docs docs
WORKDIR /build/backend/cashweb
# Cargo checks source mtimes; force workspace freshness when reusing a target cache
# across isolated checkouts. Native dependencies stay cached.
RUN --mount=type=cache,sharing=locked,id=frank-labs-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,sharing=locked,id=frank-labs-git,target=/usr/local/cargo/git \
    --mount=type=cache,sharing=locked,id=frank-labs-target,target=/build/backend/cashweb/target \
    find /build/backend /build/docs -type d -name target -prune -o -type f -exec touch {} + && \
    cargo build --locked --release -p cashwebd-exe && cp target/release/cashwebd-exe /cashwebd-exe
COPY backend/labs/backend_contract.rs cashweb-registry/tests/lab_backend_contract.rs
COPY backend/labs/copy-test-artifact.py /copy-test-artifact.py
RUN --mount=type=cache,sharing=locked,id=frank-labs-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,sharing=locked,id=frank-labs-git,target=/usr/local/cargo/git \
    --mount=type=cache,sharing=locked,id=frank-labs-target,target=/build/backend/cashweb/target \
    find /build/backend /build/docs -type d -name target -prune -o -type f -exec touch {} + && \
    cargo test --locked --release -p cashweb-registry --test lab_backend_contract --no-run --message-format=json > /tmp/lab-artifacts.json && \
    python3 /copy-test-artifact.py /tmp/lab-artifacts.json /lab-backend-contract real_nats_notification_and_durable_offline_catch_up

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
FROM runtime AS relay
COPY --from=builder /cashwebd-exe /usr/local/bin/cashwebd-exe
ENTRYPOINT ["cashwebd-exe", "/etc/cashwebd/cashwebd.toml"]
FROM runtime AS contract
COPY --from=builder /lab-backend-contract /usr/local/bin/lab-backend-contract
ENTRYPOINT ["lab-backend-contract", "--nocapture"]
