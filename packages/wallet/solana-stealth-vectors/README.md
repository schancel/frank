# Offline Solana stealth proposal vectors

Synthetic secrets only. Unallocated proposal, not cryptographic approval or a production signer. Nothing here is imported by the wallet or submits transactions.

Source is `generate.py`; generated output is `vectors.json`. From repository root:

```sh
python3 packages/wallet/solana-stealth-vectors/generate.py --check
node packages/wallet/solana-stealth-vectors/verify.mjs
cargo run --offline --locked --manifest-path packages/wallet/solana-stealth-vectors/dalek/Cargo.toml
```

After reviewing an intentional change to the proposed algorithm, regenerate with:

```sh
python3 packages/wallet/solana-stealth-vectors/generate.py
```

Python uses independent variable-time reference arithmetic, Node compares Noble arithmetic and OpenSSL verification, and Rust compares Dalek arithmetic and its expanded-key signature primitive. Node also parses and round-trips fixed native Solana transactions. Synthetic SPL derivation contexts do not establish SPL transaction correctness.

See [algorithm proposal](../../../docs/plans/solana-stealth-crypto-proposal.md) and [backend decision](../../../docs/plans/solana-stealth-backend-decision.md) for assumptions, scope and unresolved approvals.
