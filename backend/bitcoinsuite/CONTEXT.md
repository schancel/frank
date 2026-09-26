# bitcoinsuite

A collection of Rust libraries and tools for interacting with Bitcoin-like blockchains: Bitcoin Cash (BCH), eCash (XEC), Lotus (XPI), and Ergon (XRG).

## Stack
- Rust, multi-crate workspace
- Build: `cargo make`

## Purpose
Shared blockchain primitives (transactions, scripts, addresses, RPC clients) used by other projects like `cashweb` and `lotusd` tooling.

## Notes
- Depends on `cmake`, `protobuf-compiler`, `flatbuffers`
- Sibling repo to `cashweb` (expects both to be checked out side by side)
