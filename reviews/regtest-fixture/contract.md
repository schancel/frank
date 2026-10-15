# Owned regtest template readiness contract

Tier 2 ordinary test fixture. Base: ecaf950145949e7733b543cefdc5852fdf825ce7.

Current owner: the existing shared regtest fixture starts an isolated node and exposes RPC; its mining RPC readiness does not establish getblocktemplate readiness. The preserved B1 composition is investigation evidence only and remains untouched.

Target owner: a separate import-safe fixture owns its verified ABC 0.34.0 executable identity, temporary datadirs, two loopback-only processes, RPC cookies, readiness, and teardown. A typed ready handle exposes RPC and idempotent stop. Importing creates nothing. No persistent or wire format changes; no shared fixture changes, swaps, adapters, financial transactions, wallet creation, external peers, or validation bypass flags.

Acceptance: actual disconnected getblocktemplate returns -9; normal peer handshake plus initialblockdownload=false precede a real template response. Pinned archive and binary comparison required without downloads. Shutdown on startup failure, timeout, signals, and explicit stop removes only owned datadirs and closes owned ports. Pure-import side effects must fail the test. Whole repository typecheck and independent exact-tip review required.

Upstream diagnosis: https://github.com/Bitcoin-ABC/bitcoin-abc/blob/v0.34.0/src/rpc/mining.cpp#L902-L911 checks peer count then IBD. https://github.com/Bitcoin-ABC/bitcoin-abc/blob/v0.34.0/src/validation.cpp#L1441-L1465 checks tip age even on regtest. Fresh genesis nodes handshake but cannot leave IBD by waiting. Coordinator authorized exactly one ordinary generatetodescriptor block to raw(6a), an unspendable OP_RETURN coinbase. No wallet or key material is created. Both peers must report height 1, identical bootstrap hash, IBD=false, and a completed ping after negotiated protocol version; then template height 2 must return. Peer synced_blocks is not a readiness signal on the bootstrap sender: it may remain -1 even after both nodes have validated the same block.
