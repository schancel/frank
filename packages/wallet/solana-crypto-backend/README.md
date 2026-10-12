# Experimental Solana custody crypto backend

Experimental native Rust and real browser WASM implementation of the unallocated recipient-only stealth proposal. No production application composition, supported payment capability, signed-operation recovery or cryptographic approval is included. Existing Solana refusal stays enabled.

The sender prerequisite adds `primaryPublicKey`, deterministic `deriveDestination(intent)` and fully bound `signPrimaryTransfer(descriptor, spend, authorization)`. See [the frozen sender contract](sender-contract.md) for the exact new sender-ephemeral HMAC derivation and custody/financial ownership. This changes neither published spending keys nor recipient Q/zP. Fresh distinct authorized payments require fresh owner operation IDs; identical seed+intent reproduces identical R/P after reopening. Sender seed compromise exposes historical outgoing linkage. No random fallback or secret persistence is introduced. Core primary signing requires existing destination ATAs, explicit zero rent/no creation, checked fee ceilings and maximum native debit; the dependent ATA predecessor permits explicit classic SPL idempotent destination creation with positive quoted rent and full maxFee+maxRent native budget. Quoted RPC facts remain the financial owner's responsibility: an ATA instruction cannot encode a rent ceiling. No extra native transfer is emitted.

Typed host shapes are in `runtime.d.mts`. Independent sender fixture source is `sender-vectors.py`, output `sender-vectors.json`; check with `python3 packages/wallet/solana-crypto-backend/sender-vectors.py --check`, regenerate only after reviewing an intentional contract change by omitting `--check`. The browser harness compares deterministic sender destinations with those Python vectors and primary signatures with standard seed-based Noble signing plus OpenSSL verification. It rejects tampered approved R/P, destinations, contexts, amounts, source owners and fee/rent caps.

`CustodyScope` owns the existing 32-byte Solana spending seed; it changes no derivation. `prepare` checks the captured canonical chain against the authoritative protocol registry, strict recipient/ephemeral points, recipient seed affinity, positive amount, full asset/context transcript and claimed destination. It derives p and zP privately. `BoundSigner` captures a copy of the exact reviewed message and offers a private consuming `sign()` with no message argument. The caller must have authenticated the directory descriptor and validated the entire transaction policy before calling this internal seam. This module does not interpret a Solana message or prove its instructions implement the amount in the descriptor.

The scope and signer implement neither Debug nor Clone and expose no seed/scalar getter. Revocation and scope drop invalidate prepared children. Signing checks liveness before computing and before returning a locally verified signature. Future host/session integration must revoke the scope on account changes; nothing currently wires it into app lifecycle. Owned seed/hash/scalar/shared-point/prefix buffers use Zeroizing or explicit zeroization, and Dalek's expanded secret uses its zeroize feature. This is best-effort memory hygiene: SHA/HMAC implementation states, compiler temporaries and copied registers are not comprehensively erased by these wrappers. Side-channel and memory-lifetime review remains required.

Rust scalar/key internals are private. The WASM binding exports a seed-ingestion handle, public primary key/destination derivation/received-descriptor validation, typed `signReceivedTransfer`/`signPrimaryTransfer` and `close`; it does not export arbitrary-message signing, expanded keys, seeds or scalars. `runtime.mjs` keeps the native handle in a closure, synchronously captures/wipes the caller's seed handoff buffer, wipes the temporary buffer after WASM ingestion, and exposes only typed signing and idempotent close. No JavaScript secret-key fallback exists. WebAssembly linear memory is not a security boundary against malicious same-origin code; the absence of getter methods does not establish memory confidentiality.

`transfer.rs` builds a closed v0 message containing one transfer, an optional explicitly authorized ATA creation and one experimental authorization memo, with no lookup tables, arbitrary extra instructions or native allowance. Both authorized signing methods can explicitly authorize the fixed classic ATA creation described above. Native transfers use the exact decimal-string u64 amount. SPL uses plain SPL Token TransferChecked, exact mint/program/amount/decimals, source and destination ATAs derived from the respective owners, and rejects other programs including Token-2022. Unknown fields, wrong chain/asset/owner and inexact amounts fail before signing. An experimental memo binds the source derivation descriptor and outgoing owner/destination/amount/blockhash/operation/context/decimals to the exact signature; its domain is unallocated and does not change Frank's wire protocol. Original receipt amount and authorized outgoing spend amount are distinct facts.

The future wallet owner must authenticate the receipt, select/configure the mint, verify live decimals/account ownership and balances, enforce fee/rent/spending policy, reserve inputs and durably journal exposure before submission. The builder does not create/fund missing ATAs, supply native gas or verify an RPC. The selected product policy remains `needs-native-gas`, with no extra sender funding. The application does not import this experimental adapter or advertise its capability.

## Received-source successor

See [the received-source contract](received-contract.md). Public `validateReceivedDescriptor({descriptor, publicKey})` proves seed/strictpoint/full-Q destination affinity without signing or inventory mutation. `signReceivedTransfer(received, newSenderDescriptor, spend, authorization)` reconstructs the original p/zP, validates the complete new outgoing intent and economic caps, and signs the closed builder. Its memo binds both original received Q/P and outgoing intent. The obsolete public `signTransfer` method is removed, with no compatibility alias. Original derivation asset/amount are not current balance: independently observed SOL/token balances at that owned P can be spent in another asset, with selected-asset balance and fee/rent checks belonging to the financial owner. No nonce formula changes.

The real browser test validates synthetic public descriptors, persists only those descriptors in disposable localStorage, closes/reopens custody, and resends native-from-SPL-derived and SPL-from-native-derived sources. Python reconstructs each signature independently from the published synthetic vector p/zP; Noble/OpenSSL and web3 verify signatures and exact source/transfer accounts. This establishes descriptor restoration/signing, not actual chain receipt import or financial inventory recovery; those remain the dependent owner's integration proof.

## Offline checks and source ownership

Source: `lib.rs`, `transfer.rs`, `bindings.rs` and `runtime.mjs`; behavioral tests: `tests.rs`, transfer unit tests and `browser-test.mjs`. Independent fixture source/output: sibling `../solana-stealth-vectors/generate.py` and `vectors.json`. From repository root:

```sh
cargo test --offline --locked --manifest-path packages/wallet/solana-crypto-backend/Cargo.toml
cargo fmt --manifest-path packages/wallet/solana-crypto-backend/Cargo.toml --check
python3 packages/wallet/solana-stealth-vectors/generate.py --check
node packages/wallet/solana-stealth-vectors/verify.mjs
```

Only after reviewing an intentional algorithm change, regenerate the oracle with:

```sh
python3 packages/wallet/solana-stealth-vectors/generate.py
```

The backend must match external Python-produced vectors, independently checked by Noble/OpenSSL and the separate Dalek oracle. No tests derive their expected signature using this backend. Tests cover exact transcript/signatures, full context mutations, canonical chain/recipient affinity, malformed points, immutable message capture and revoke/drop behavior. Synthetic seed fixtures are intentionally public and never production credentials.

## Reproducible browser build

Build with Rust 1.93.0 plus its `wasm32-unknown-unknown` target and wasm-bindgen CLI exactly 0.2.129, matching Cargo.lock. Local validation installed those tools into task-specific RUSTUP_HOME/CARGO_HOME/install-root paths, leaving global tooling unchanged. `SOLANA_CARGO_BIN`, `RUSTC`, `CARGO_HOME`, `CARGO_TARGET_DIR` and `SOLANA_WASM_BINDGEN` can point to such an isolated installation; none is baked into source. The build script verifies bindgen's exact version, uses offline locked Cargo, and prints output hashes.

```sh
bash packages/wallet/solana-crypto-backend/build-wasm.sh
node packages/wallet/solana-crypto-backend/browser-test.mjs
```

Generator/build source is `build-wasm.sh` plus the Rust sources/Cargo.lock. Output is `generated/backend.js`, `backend_bg.wasm` and their generated declarations. Outputs are ignored build artifacts; rebuild before running the browser harness. Do not hand-edit generated glue. A future Vite composition must supply an explicit `backend_bg.wasm?url` asset URL to the adapter. No third-party DKLS source is modified.

The real disposable Chrome test uses a loopback server with a same-origin CSP and synthetic credentials. It signs native and configured-devUSDC synthetic transfers in WASM, compares the exact signatures with independent Python arithmetic, verifies them through Noble/OpenSSL, parses actual Solana messages and checks ATA derivation with web3.js. It checks host seed wipe on success/failure, closed-handle rejection, deterministic reopen, op/context message binding and invalid-request rejection. This proves signing/serialization and derivation, not funded receipt, ATA existence, RPC submission or restored financial inventory. It uses no owner profile, funds or live chain.

The adapter accepts an optional host AbortSignal: abort before initialization rejects opening and wipes the handoff; abort after opening closes the native handle and prevents further signing. Application custody/session integration must connect that signal or call close on account or network changes; that lifecycle is not wired into app code yet. Scheme/version, exact messaging-context construction, memo adoption and signing-key/ECDH cross-use still need acceptance and independent crypto/wire/custody review. Browser success and matching signatures do not resolve those decisions or complete multiasset payments.
