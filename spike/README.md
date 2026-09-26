# Stamp burn-to-speak spike (THROWAWAY)

Proves, end to end, against the **real live Monad testnet** (via a real Alchemy
RPC endpoint): a sender can burn MON with a commitment hash in calldata, and a
receiver can independently verify that burn on-chain and decrypt the original
message, using this repo's **real** `app/src/cashweb/relay/crypto.ts` for E2E
encryption.

This is a spike for tickets #1-#9 (https://github.com/schancel/frank/issues) —
throwaway code, not part of the tracked backlog, not reviewed/merged normally.

## Status (as of this run)

- **Blocked on funding.** A fresh chain wallet was generated but has 0 MON.
  See "Funding" below.
- Everything up to the actual on-chain send has been verified against the
  real network (RPC connectivity, chain ID 10143, balance query) and the real
  crypto code (encrypt/decrypt round-trip, commitment hash match) — see
  `spike/dryrun.ts` output and `spike/sender.ts`'s dry-run-to-the-abort-point
  output in the handoff report.
- **No chain calls are mocked.** If sender.ts/receiver.ts print a tx hash or
  "CONFIRMED", it's real. If something can't be verified on-chain, the
  scripts fail loudly instead of pretending to succeed.

## What's real vs what's stubbed

Real:
- E2E encryption/decryption: literally imports and calls
  `PayloadConstructor` from `../app/src/cashweb/relay/crypto.ts` (no copy, no
  reimplementation). Uses its ECDH shared-key derivation (secp256k1 point
  multiplication via bitcore-lib-xpi) + AES-CBC encrypt/decrypt.
- RPC: real Alchemy Monad testnet endpoint from `frank/.env`
  (`MONAD_TESTNET_HTTP_RPC_URL`), read but never modified.
- Tx send/receipt/calldata read: real `ethers` JsonRpcProvider calls, no
  mocking.

Stubbed (explicitly out of scope for this spike, per ticket description):
- No relay server. "Out-of-band delivery" of the encrypted payload is a local
  JSON file (`spike/data/payload.json`) the receiver script reads directly.
- No wallet pool / POP machinery (tickets #1-#9) — just one sender wallet,
  one burn tx.
- Messaging identity keys (sender/recipient, for ECDH) and the chain wallet
  (for signing the tx) are separate, unrelated keypairs — real systems might
  tie these together, out of scope here.

## Commitment hash domain

```
h_m = keccak256( utf8(message) || senderPubKeyCompressed(33 bytes) || timestampBE(8 bytes, unix seconds) )
```

Hashed over the **plaintext** message (not ciphertext) — see
`spike/lib/commitment.ts` for the one-paragraph rationale. Exact domain
separation doesn't matter for a spike, just consistency between sender and
receiver, which is enforced by both scripts importing the same
`computeCommitment()` helper.

## Setup (one-time)

Dependencies (`ethers`, `node-forge`, `bitcore-lib-xpi`, `tsx`, `typescript`)
are installed via a throwaway `package.json` at the **worktree root**
(`/Users/shammah/repos/frank-worktrees/spike-demo/package.json`), not inside
`app/`. This was a deliberate choice: `app/` has no `node_modules` installed,
and a bare `npm install` inside `app/` pulls in the *entire* existing
dependency tree (quasar/electron/capacitor/protobuf toolchain/etc.), which is
slow and in this environment outright fails (a `protoc` postinstall script
doesn't support this machine's platform). Installing at the worktree root
avoids all of that, while still letting Node's module resolution find
`bitcore-lib-xpi`/`node-forge` when `app/src/cashweb/relay/crypto.ts` is
imported directly (Node walks up from the importing file's directory, and the
worktree root is a common ancestor of both `app/src/...` and `spike/`).

```bash
cd /Users/shammah/repos/frank-worktrees/spike-demo
npm install          # already done
npx tsx spike/keygen.ts   # already done — generates keys in spike/data/ (gitignored)
```

## Funding

The chain wallet needs testnet MON before a real burn tx can be sent:

```
address: 0xf7a977F50E825D9f9ea403a03Fca9828FEa65E9c
```

Fund via a Monad testnet faucet, then confirm with:

```bash
npx tsx spike/check-balance.ts
```

## Running the demo (once funded)

```bash
# Sender: encrypts message, computes h_m, sends real burn tx, waits for confirmation
npx tsx spike/sender.ts "Meet at the docks at midnight"

# Receiver: fetches real receipt via Alchemy, decrypts payload, re-verifies h_m
npx tsx spike/receiver.ts <txHash printed above>
```

## Crypto-only dry run (no chain calls, for sanity-checking the pipeline)

```bash
npx tsx spike/dryrun.ts "some message"
```

This exercises encrypt -> compute h_m -> decrypt -> recompute h_m -> compare,
entirely locally. It is **not** proof of an on-chain burn — it only proves the
crypto/commitment logic is internally consistent. Useful for catching bugs
(and did: see below) before spending real testnet gas.

## Bug found & fixed during this spike

`bitcore-lib-xpi`'s `PrivateKey.fromBuffer()` on a raw 32-byte buffer defaults
`compressed: false`, silently producing a *different* (uncompressed, 65-byte)
public key than the one originally generated (compressed, 33-byte). This
broke the sender/receiver commitment match (h_m mismatch) despite the
decrypted message round-tripping correctly. Fixed by storing/loading private
keys via WIF (`toWIF()`/`fromWIF()`), which encodes the compression flag
explicitly. See `spike/keygen.ts` for the note.
