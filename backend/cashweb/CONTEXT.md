# cashweb

Rust backend for CashWeb — peer-to-peer E2E encrypted messaging using crypto as a spam protection mechanism.

## Stack
- Rust
- Depends on `bitcoinsuite` (must be checked out as a sibling directory)
- Requires `protobuf-devel`

## Purpose
Messaging protocol server. Users pay tiny amounts of crypto to send messages, eliminating spam incentives.

## Notes
- Config in `cashwebd-exe/config.toml`
- Related to the `stamp` frontend (Lotus-powered cryptomessenger)
