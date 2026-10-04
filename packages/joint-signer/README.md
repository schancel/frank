# `@frank/joint-signer`

One interface for a key that two players hold together, with replaceable
implementations ("backends") behind it. The game layer talks to a
`JointSigner` and never to a backend.

**Experimental. Testnet only. Not for real funds.** Nothing in this package
has had an outside review. One backend runs a WebAssembly module built from
our modified copy of third-party code (`third_party/silent-shard-dkls23-ll`)
under a **non-commercial licence**; read
[Licence of the silence-dkls backend](#licence-of-the-silence-dkls-backend)
before shipping anything that includes it.

## In plain words

- Two players run key generation and get one ordinary EVM address that
  belongs to both. Neither can sign alone.
- To sign a transfer they exchange five messages and both end up with a normal
  signature (64 bytes, low-s, plus the recovery bit) that any EVM node accepts.
- They can instead make a _pre-signature_ locked to a secret one of them
  holds: whoever knows the secret turns it into a real signature, and doing so
  reveals the secret to the other.
- Which implementation does the work is a choice made in one place. Two exist:

|                                    | `silence-dkls`                                        | `frank-lindell`                                         |
| ---------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| What it is                         | our fork of Silence Laboratories' DKLs23, WebAssembly | `@frank/threshold-ecdsa`, our TypeScript (Lindell 2017) |
| Key generation, per party          | about 0.5 to 1.1 s                                    | about 7 to 20 s                                         |
| Signature, per party               | about 0.05 to 0.2 s                                   | about 0.07 to 0.3 s                                     |
| Pre-signature, per party           | about 0.09 to 0.25 s                                  | about 0.14 to 0.6 s                                     |
| Messages: key generation / signing | 5 / 5                                                 | 8 / 5                                                   |
| Largest message                    | about 113 KB                                          | about 46 KB (signing: 550 bytes)                        |
| Stored key share                   | about 124 KB                                          | about 1.3 KB                                            |
| Roles                              | either party, either role, every session              | fixed per key                                           |
| Pre-signatures ("locks")           | yes (added by our fork)                               | yes                                                     |
| Key tweak                          | no                                                    | yes                                                     |
| A new key per hand                 | run key generation again                              | tweak the pair's key                                    |
| Licence                            | non-commercial only                                   | MIT                                                     |
| Outside review                     | none of our changes; see "Audit status" below         | none                                                    |

Times were measured under jest on a busy Apple M4 (load average 27 to 55 on
10 cores; the lower figures at the lower load). The suites print them.

## Using it

```ts
import type { JointSigner } from '@frank/joint-signer'
import { loadSilenceDklsNode } from '@frank/joint-signer/src/silence-dkls/load-node.js'
// browser: const signer = await loadSilenceDklsWeb(wasmUrl)  (load-web.js)
// or:      const signer = createFrankLindellBackend()

const signer: JointSigner = loadSilenceDklsNode()

let step = must(signer.startSign({ key, role, sessionId, digest, randomBytes }))
if (step.outgoing) transport.send(step.outgoing)
while (step.result === null) {
  const next = signer.signStep(step.session, await transport.receive())
  if (!next.ok) {
    if (next.error.keyUnusable) await storage.markUnusable(keyId) // durable
    if (next.error.sessionAborted) throw new Error(next.error.code) // new session id
    continue // a stray frame; the session is still usable
  }
  step = next.value
  if (step.outgoing) transport.send(step.outgoing)
}
// step.result: { signature, recovery, publicKey, address }
```

Key generation is the same loop with `startKeygen` / `keygenStep`; its result
is a `JointKey`. Pre-signing is the same loop with `signer.locks.startPreSign`
/ `preSignStep`; its result is a 162-byte pre-signature.

## The interface

Everything returns `JointSignerResult<T>`:
`{ ok: true, value } | { ok: false, error: { code, sessionAborted, keyUnusable, peerFault, backendCode } }`.
Errors never contain data. Full definitions are in `src/types.ts`.

```ts
interface JointSignerCore {
  capabilities: JointSignerCapabilities

  startKeygen(input: {
    role: 'initiator' | 'responder'
    sessionId: Uint8Array // 32 bytes, agreed, new every time
    localId: Uint8Array // 1..64 bytes
    peerId: Uint8Array // 1..64 bytes, different
    randomBytes: (length: number) => Uint8Array
  }): JointSignerResult<Step<KeygenSession, JointKey>>
  keygenStep(
    session: KeygenSession,
    message: Uint8Array,
  ): JointSignerResult<Step<KeygenSession, JointKey>>
  abortKeygen(session: KeygenSession): void

  describeKey(key: JointKey): JointSignerResult<{
    keyId: Uint8Array // 32 bytes, equal on both sides
    publicKey: Uint8Array // 33 bytes
    address: Uint8Array // 20 bytes
    localId: Uint8Array
    peerId: Uint8Array
    keygenRole: Role
    signRoles: readonly Role[] // the roles this party may take when signing
    usable: boolean
  }>
  exportKey(key: JointKey): JointSignerResult<Uint8Array> // SECRET
  importKey(bytes: Uint8Array): JointSignerResult<JointKey>
  destroyKey(key: JointKey): JointSignerResult<true>

  startSign(input: {
    key: JointKey
    role: Role // must be one of signRoles
    sessionId: Uint8Array // 32 bytes, agreed, never reused with this key
    digest: Uint8Array // 32 bytes
    tweakCommitment?: Uint8Array // only with capabilities.keyTweak
    randomBytes: RandomBytes
  }): JointSignerResult<Step<SignSession, JointSignature>>
  signStep(
    session: SignSession,
    message: Uint8Array,
  ): JointSignerResult<Step<SignSession, JointSignature>>
  abortSign(session: SignSession): void

  exportSignSession(session: SignSession): JointSignerResult<Uint8Array> // SECRET
  importSignSession(input: {
    state: Uint8Array
    key: JointKey
    randomBytes: RandomBytes
  }): JointSignerResult<SignSession>
}

interface Step<Session, Result> {
  session: Session // pass to the next step call; the one passed in is consumed
  outgoing: Uint8Array | null // deliver to the other party
  result: Result | null // non-null once this party is done
}

interface JointSignature {
  kind: 'signature'
  signature: Uint8Array // r (32) || s (32), low-s
  recovery: 0 | 1 // EIP-1559 yParity
  publicKey: Uint8Array // 33 bytes
  address: Uint8Array // 20 bytes
}

type JointSigner = LockingJointSigner | PlainJointSigner
```

### Locks and pre-signing (`signer.locks`)

```ts
type JointLock =
  | {
      kind: 'point'
      point: Uint8Array
      proof: Uint8Array
      ownerProof: Uint8Array
    }
  | {
      kind: 'commitment'
      commitment: Uint8Array
      proof: Uint8Array
      index: number
    }

type JointLockOpening =
  | { kind: 'point'; secret: Uint8Array }
  | { kind: 'commitment'; secret: Uint8Array; value: number } // value: the committed value

interface LockFeature {
  lockCreator: Role // who holds lock secrets; the other party extracts them
  createPointLock(input: {
    key
    randomBytes
  }): Result<{ secret; lock; opening }>
  createCommitmentLock(input: {
    key
    value
    randomBytes
  }): Result<{ secret; commitment; proof; opening }>
  commitmentLockPoint(commitment, index): Result<Uint8Array>
  startPreSign(input: {
    key: JointKey
    role: Role
    sessionId: Uint8Array
    digest: Uint8Array
    lock: JointLock // public; both parties pass the same one
    lockOpening?: JointLockOpening // the HOLDER only
    randomBytes: RandomBytes
  }): Result<Step<PreSignSession, JointPreSignature>>
  preSignStep(session, message): Result<Step<PreSignSession, JointPreSignature>>
  abortPreSign(session): void
  completeCommitmentLock(input: {
    publicKey
    commitment
    index
    digest
    adaptorSignature
    secret
  }): Result<{ signature; recovery }>
  extractCommitmentLockSecret(input: {
    publicKey
    commitment
    index
    digest
    adaptorSignature
    completedSignature
  }): Result<Uint8Array>
}
// JointPreSignature = { kind: 'adaptor-signature', adaptorSignature (162 bytes), publicKey, address }
```

- Two kinds of lock, in the format of `@frank/threshold-ecdsa`, byte for
  byte, on both backends. A _point lock_ is `T = t*G` with proofs that someone
  knows `t`. A _commitment lock_ is a commitment `C = s*G + v*H` to a value `v`
  (a card, say) with a proof that someone knows `(s, v)`; pre-sign once per
  candidate value `index`, and only the pre-signature for `index = v` can be
  completed, with `s`.
- **The holder must be able to open the lock.** The party that holds the
  secret (`lockCreator`; on both backends the responder of the pre-signing
  session) passes `lockOpening`, the `opening` it got from `createPointLock`
  or `createCommitmentLock`, and is refused with `lock-not-owned` if it does
  not open exactly this lock. The other party must not pass one
  (`invalid-input`). Without this rule the other party could build a lock from
  a secret of its own, name the holder in its proofs, and later complete the
  pre-signature alone; the public proofs cannot tell the difference.
- A caller-chosen point without proofs is never accepted.
- Point locks are completed and extracted with `completeAdaptorSignature` and
  `extractAdaptorSecret` from `@frank/adaptor-signatures`; commitment locks
  with the two functions above.
- The initiator receives the pre-signature first. That is why the holder is
  the responder: a withholding initiator has a pre-signature it cannot
  complete.

### Capabilities

```ts
interface JointSignerCapabilities {
  backend: string
  roles: 'symmetric' | 'fixed-per-key'
  adaptorLocks: boolean // true exactly when signer.locks exists
  keyTweak: boolean // true exactly when signer.tweak exists
  keygenSessionExport: boolean // true exactly when signer.keygenSessions exists
  keygenMessages: number
  signMessages: number
  maxMessageBytes: number
  perHandKey: 'keygen' | 'tweak'
}
```

- **Roles.** With `fixed-per-key`, the key-generation initiator initiates
  every signing session with that key (and is the party that extracts lock
  secrets); `startSign` with the other role fails with `role-fixed`. Two
  players who need both assignments generate two keys. With `symmetric`, any
  role in any session. Portable game code reads `describeKey(key).signRoles`.
- **Pre-signing cannot be called on a backend without it.** It lives only on
  `signer.locks`. A backend without the capability has no `locks` property:
  the type is `undefined`, so `signer.locks.startPreSign(...)` does not compile
  until the caller has checked `signer.locks !== undefined`, and at run time
  there is nothing to call. `startSign` never pre-signs, and a pre-signing
  session never returns an ordinary signature.
- **Key tweak** (`signer.tweak`, and `tweakCommitment` in `startSign`) and
  **stored key-generation sessions** (`signer.keygenSessions`) follow the same
  rule. `tweakCommitment` on a backend without tweaks fails with `unsupported`.
- **A new key per hand.** `perHandKey` says how: `keygen` (generate a new key;
  about half a second on `silence-dkls`) or `tweak` (one key per pair, tweaked
  per hand).

## Rules for callers

They hold for every backend. Breaking them can leak or lose the key.

1. **Authenticate the transport.** Every message must be known to come from
   the other party before it reaches a step function. `peerFault` means
   nothing otherwise, and on `frank-lindell` a forged message can burn a key.
2. **Session ids are single-use per key.** After any error with
   `sessionAborted`, retry with a new session id.
3. **One state, one message.** A step consumes the state it is given
   (`state-already-used` afterwards).
4. **Stored sessions** (`exportSignSession`): store the new state before
   sending that step's `outgoing`; after a crash load only the newest state;
   never load one state twice or an old state once a newer exists. Feeding one
   stored state two different messages reuses a nonce and can give the other
   party the key. If you cannot guarantee this, do not store sessions: start a
   new one, signing is cheap. Stored states carry a MAC keyed from the key
   share and are refused if altered; the MAC cannot tell an old state from the
   newest. Pre-signing sessions cannot be stored.
5. **`keyUnusable` is forever.** Record it, delete stored copies.
6. **Stored keys are secret.** They carry a MAC against alteration by someone
   who cannot read them; store them encrypted all the same.
7. **Who initiates.** The initiator learns the result first and can withhold
   the last message. For plain signing make the initiator the party for whom
   that is harmless; for pre-signing the backend fixes it (the holder
   responds).
8. **A lock secret is used once.** Every commitment needs its own fresh
   secret; completing one pre-signature publishes it.

## The `silence-dkls` backend

`src/silence-dkls/backend.ts` wraps the WebAssembly build of
`third_party/silent-shard-dkls23-ll`: Silence Laboratories' DKLs23 library at
its 1.2.0 release, **modified by us** (that directory's `CHANGES` lists what
and when). The backend takes the loaded module as a value
(`createSilenceDklsBackend(module)`); `load-node.ts` and `load-web.ts` are the
two loaders. No npm package is involved.

What our fork changes in the library:

- **A session signs one digest.** The original can stop after three rounds
  with a message-independent pre-signature and then sign any digest with it;
  using one for two digests gives away the key. In the fork the digest is
  given when the session is created, mixed into the session id, and round 3
  goes straight to the partial signature; the one-time secrets are wiped in
  the same call.
- **Adaptor pre-signing**, described at the top of
  `third_party/silent-shard-dkls23-ll/src/adaptor.rs`. Lock proofs are
  verified inside the wasm, which also repeats the holder's opening check, and
  the result is verified as a third party would verify it.

What this wrapper adds around the wasm, all of it ours:

- **A frame around every message**: backend, protocol, round and a 32-byte
  binding of the session id, key, digest, initiator and (for pre-signing) the
  lock. Stray, duplicated and out-of-order messages are refused by the frame
  check. The same binding is given to the wasm.
- **Turn-taking.** DKLs23 is written as rounds in which both parties send at
  once. Here the parties alternate, five messages per protocol, each carrying
  every wasm message its sender can already compute. _Review item:_ each wasm
  message is still computed from exactly its specified inputs, but this
  ordering is ours.
- **Sessions as bytes.** The wasm session exists only inside one step call:
  rebuilt from bytes, advanced, serialised, freed.
- **Caller-supplied randomness.** Every wasm call that draws randomness is
  given a 32-byte seed from `randomBytes`; the wasm expands it with ChaCha20.
- **Integrity of stored keys and signing sessions** (HMAC-SHA256 keyed from
  the key share, checked before anything is parsed).
- **Locks** (`src/locks.ts`): creation, the holder's opening check, completion
  and extraction. A second, independent verification of every pre-signature
  with the verifier of `@frank/adaptor-signatures`.

Not provided by this backend: key tweak, an explicit key confirmation round,
and a durable "this share is burned" rule (DKLs23 has no equivalent of the
Lindell abort rule; a failed session just aborts).

**Audit status, precisely.** Trail of Bits reviewed Silence Laboratories'
`dkls23-rs` and `sl-crypto` repositories (report dated February 9, 2024, in
`github.com/silence-laboratories/dkls23`, `docs/`). The library forked here
comes from a different repository, `silent-shard-dkls23-ll`, which that report
does not list as a target, and we have changed it. Nothing we added was
reviewed by anyone.

### Licence of the silence-dkls backend

Everything under `third_party/silent-shard-dkls23-ll`, including our changes
and the built WebAssembly, is under the "Silence Laboratories' Non-Commercial
Use License Agreement" (`LICENSE.md` there), **not** MIT. This package's own
source is MIT and contains none of that code; it loads the built module.

The licence asks, among other things, that everyone who receives the software
gets the licence text and a prominent notice that the library is used, that
it was modified (what, when, independently of Silence Laboratories), and this
sentence:

> This software library is licensed under the Silence Laboratories License
> Agreement, Copyright © Silence Laboratories Pte. Ltd. All Rights Reserved.

In the repository that is `third_party/silent-shard-dkls23-ll/CHANGES`; in the
app it is the About screen (`app/src/pages/About.vue`). Whether a given use is
"non-commercial" is, in the licence's words, "determined by Silence
Laboratories in its sole discretion".

The backend can be removed without touching the game layer: delete
`src/silence-dkls/`, `third_party/silent-shard-dkls23-ll/`, the About notices
and the one line that chooses the backend.

## Building the wasm

The built node and web modules are committed
(`third_party/silent-shard-dkls23-ll/pkg/`, hashes in `pkg/SHA256SUMS`), so
tests and the app need no Rust. To rebuild after changing the Rust source:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.92 --locked
third_party/silent-shard-dkls23-ll/build-wasm.sh
```

## In the browser

Not run in a browser yet. From reading the generated glue:

- Use `load-web.ts`. It needs one asynchronous `init()` before first use,
  which fetches and instantiates a 931 KB `.wasm` (about 260 KB gzipped; the
  build does not run `wasm-opt`). Under Vite pass the asset URL explicitly:
  `import wasmUrl from '<repo>/third_party/silent-shard-dkls23-ll/pkg/web/dkls-wasm-ll-web_bg.wasm?url'`.
- No `SharedArrayBuffer`, no threads, no cross-origin isolation headers, no
  top-level await. A Content-Security-Policy, if the app adds one, must allow
  WebAssembly (`'wasm-unsafe-eval'`).
- It works in a Web Worker the same way (the glue uses `fetch`,
  `WebAssembly` and `crypto.getRandomValues`, nothing from `window`). Key
  generation blocks for about half a second per party in total; a worker is
  advisable but not required.

## Replacing a backend

A new backend is a function that returns a `JointSigner`. It replaces an
existing one with no change to the game layer when:

1. `runConformance(name, create)` from `src/conformance.ts` passes for it
   (add one line to `src/conformance.jest.test.ts`), and
2. its `capabilities` are at least those the game layer relies on. A game that
   uses locks needs `adaptorLocks`; one that swaps signing roles needs
   `roles: 'symmetric'`.

A backend with locks must accept and produce locks in the format above;
`src/locks.ts` implements that format without any backend and can be reused.

Keys and stored sessions do not carry over between backends: a stored key
names its backend and another backend refuses it (`invalid-key`). Lock proofs
are bound to a key, so locks do not carry over either. Swapping means new
keys, so do it between hands, with no funds at old joint addresses.

## Tests

`yarn test --runInBand` runs:

- `src/conformance.jest.test.ts`: one suite, unchanged, against both
  backends: key generation, an EIP-1559 transfer signature that ethers
  recovers to the joint address, refusal of garbage, duplicated, out-of-order,
  other-session and altered messages, stored keys and sessions across a
  simulated restart, the capability rules, and locks: pre-sign, complete and
  extract; a holder without an opening is refused; a lock forged by the other
  party in the holder's name cannot be pre-signed.
- `src/silence-dkls/locks.jest.test.ts`: the lock format matches
  `@frank/threshold-ecdsa` byte for byte; point locks with
  `@frank/adaptor-signatures`; only the committed candidate of a commitment
  can be completed; locks without valid proofs; parties that differ on lock,
  candidate or digest stop before any partial signature; altered pre-signing
  messages; altered stored keys and sessions.

The Rust tests of the fork run with `cargo test -p dkls23-ll` in
`third_party/silent-shard-dkls23-ll`.
