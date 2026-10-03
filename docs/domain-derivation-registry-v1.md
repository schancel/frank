# Frank domain-derivation registry v1

Status: frozen pre-production registry. Released entries are immutable.

This document defines the byte-exact derivation between the validated 32-byte
Codex32 account root `R` and every secret domain initially used by Frank. The
canonical registry identifier is `frank-domain-roots-v1`, its unsigned 16-bit
registry code is `1`, and its algorithm identifier is
`hkdf-sha256-rfc5869`. The recovery format `codex32-master-v1` has unsigned
16-bit code `1`.

## Derivation

All strings below are their exact printable ASCII bytes. Integers are unsigned
big-endian. `u16be(x)` is exactly two bytes. Every v1 output is 32 bytes.

```text
salt = ASCII("frank/domain-root-registry/v1")
PRK  = HKDF-Extract-SHA256(salt, R)

info = u16be(len(registry_id)) || ASCII(registry_id) ||
       u16be(purpose_code) ||
       u16be(len(label)) || ASCII(label) ||
       u16be(output_length)

domain_root = HKDF-Expand-SHA256(PRK, info, output_length)
```

`R` is exactly 32 bytes. An implementation must reject every other size and
every unallocated purpose. It must not use `M = R || V`, a mnemonic, PBKDF2, a
BIP-32 child, raw hashing, or a retained generic extension root in place of this
construction. A released code, label, length, interpretation, salt, framing
rule, or KDF cannot change. Such a change requires a new recovery format and an
explicit account rotation.

## Registry

| Code | Purpose                   | Exact label                                    | Downstream interpretation                                                                                                                                                |
| ---: | ------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
|    1 | `ecash-bch-wallet`        | `frank/domain-root/v1/ecash-bch-wallet`        | BIP-32 secp256k1 master seed. Chain-specific BIP-44 paths are derived only below this root.                                                                              |
|    2 | `evm-wallet`              | `frank/domain-root/v1/evm-wallet`              | BIP-32 secp256k1 master seed. The existing EVM spend/change paths are derived only below this root.                                                                      |
|    3 | `solana-wallet`           | `frank/domain-root/v1/solana-wallet`           | The exact 32-byte Ed25519 seed passed to the Solana keypair constructor; no BIP-39 or BIP-32 step.                                                                       |
|    4 | `messaging-encryption`    | `frank/domain-root/v1/messaging-encryption`    | BIP-32 secp256k1 master seed reserved exclusively for message-DH keys. Message child allocation is a separate append-only registry and can never cross into another row. |
|    5 | `identity-authentication` | `frank/domain-root/v1/identity-authentication` | BIP-32 secp256k1 master seed. Frank's fixed identity-authentication path is derived only below this root.                                                                |

There is deliberately no extension-root allocation. New independent purposes
may be appended under unused codes and distinct labels only after their exact
interpretation and vectors are frozen. Existing accounts may derive such a
purpose only when the account's recorded registry version contains it.

## Ownership and cleanup

The derivation API snapshots `R`, wipes that snapshot and the HKDF pseudorandom
key in a `finally` block, and returns a new output buffer owned by the caller.
The caller must wipe an output when its ownership ends. JavaScript runtimes,
library internals, garbage collection, copies, swap, and crash capture prevent
any claim of forensic erasure; best-effort wiping is still required to reduce
ordinary lifetime and accidental reuse.

## Vectors and review

The machine-readable corpus is
[`packages/domain-roots/vectors/domain-roots-v1.json`](../packages/domain-roots/vectors/domain-roots-v1.json).
It covers every allocated purpose for both an all-zero root and the byte
sequence `00..1f`. Package tests also reject malformed roots and purpose
substitution and prove the allocated labels and codes are unique. The package's
`check:vectors` command verifies the same corpus independently with Node's
OpenSSL-backed HKDF, while production code and tests use Noble. An independent
cryptographic review remains required before production custody; because Frank
has no real users, that review may require a new pre-production registry and
account rotation without retaining compatibility.
