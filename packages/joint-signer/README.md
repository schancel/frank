# `@frank/joint-signer`

One interface for a key that two players hold together, with replaceable
implementations ("backends") behind it. The game layer talks to a
`JointSigner` and never to a backend.

**Experimental. Testnet only. Not for real funds.** The wrapper code in this
package has had no outside review. One backend runs third-party code under a
**non-commercial licence**; read [Licence of the silence-dkls backend](#licence-of-the-silence-dkls-backend)
before shipping anything that includes it.

## In plain words

- Two players run key generation and get one ordinary EVM address that
  belongs to both. Neither can sign alone.
- To sign a transfer they exchange five messages and both end up with a normal
  signature (64 bytes, low-s, plus the recovery bit) that any EVM node accepts.
- Which implementation does the work is a choice made in one place. Two exist:

|                                    | `silence-dkls`                            | `frank-lindell`                                         |
| ---------------------------------- | ----------------------------------------- | ------------------------------------------------------- |
| What it is                         | Silence Laboratories' DKLs23, WebAssembly | `@frank/threshold-ecdsa`, our TypeScript (Lindell 2017) |
| Key generation, per party          | about 0.5 to 0.6 s                        | about 7 s                                               |
| Signature, per party               | about 0.06 to 0.1 s                       | about 0.07 s                                            |
| Messages: key generation / signing | 5 / 5                                     | 8 / 5                                                   |
| Largest message                    | about 112 KB                              | about 46 KB (signing: 550 bytes)                        |
| Stored key share                   | about 124 KB                              | about 1.3 KB                                            |
| Roles                              | either party, either role, every session  | fixed per key                                           |
| Adaptor pre-signatures ("locks")   | **no**                                    | yes                                                     |
| Key tweak                          | no                                        | yes                                                     |
| A new key per hand                 | run key generation again                  | tweak the pair's key                                    |
| Licence                            | non-commercial only                       | MIT                                                     |
| Outside review                     | see below; our wrapper has none           | none                                                    |

Times were measured under jest on a busy Apple M4 (load average about 18 to
20 on 10 cores); see the numbers the conformance suite prints.

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
is a `JointKey`.

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
- **Adaptor pre-signing cannot be called on a backend without it.** It lives
  only on `signer.locks` (`createPointLock`, `createCommitmentLock`,
  `commitmentLockPoint`, `startPreSign`, `preSignStep`, `abortPreSign`,
  `completeCommitmentLock`, `extractCommitmentLockSecret`). A backend without
  the capability has no `locks` property: the type is `undefined`, so
  `signer.locks.startPreSign(...)` does not compile until the caller has
  checked `signer.locks !== undefined`, and at run time there is nothing to
  call. `startSign` never pre-signs.
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
   new one, signing is cheap.
5. **`keyUnusable` is forever.** Record it, delete stored copies.
6. **Stored keys are secret** and, on `silence-dkls`, carry no integrity
   check of their own: store them encrypted and authenticated.
7. **Who initiates.** The initiator learns the signature first and can
   withhold the last message. Make the initiator the party for whom that is
   harmless.

## The `silence-dkls` backend

`src/silence-dkls/backend.ts` wraps the low-level message API of
`@silencelaboratories/dkls-wasm-ll-{node,web}` 1.2.0. The backend takes the
loaded module as a value (`createSilenceDklsBackend(module)`); `load-node.ts`
and `load-web.ts` are the two loaders. What the wrapper adds, all of it ours
and unreviewed:

- **A frame around every message**: backend, protocol, round and a 32-byte
  binding of the session id (for signing also the key and the digest). The
  wasm has no caller-chosen session id, and it reports a malformed message by
  trapping, which leaves its session object unusable. Stray, duplicated and
  out-of-order messages are refused by the frame check and never reach it.
- **Turn-taking.** DKLs23 is written as rounds in which both parties send at
  once. Here the parties alternate, five messages per protocol, each carrying
  every wasm message its sender can already compute. _Review item:_ each wasm
  message is still computed from exactly its specified inputs, but this
  ordering is ours, not the library's examples'.
- **No pre-signatures.** The wasm can stop after three rounds with a
  message-independent pre-signature; using one for two digests gives away the
  key. Here the digest is fixed at `startSign`, bound into every frame, and
  the pre-signature is consumed in the step that creates it. It is never
  returned or stored.
- **Sessions as bytes.** The wasm session exists only inside one step call:
  rebuilt from bytes, advanced, serialised, freed. That is what makes
  `exportSignSession` and stored key generation possible, and it keeps a
  failed step from poisoning anything else. A wasm object whose call trapped
  cannot be freed and is leaked (one per aborted session).
- **Caller-supplied randomness.** Every wasm call that draws randomness is
  given a 32-byte seed from `randomBytes`; the wasm expands it with ChaCha20.
  (Left alone the wasm would use the platform CSPRNG.)

**Audit status, precisely.** Trail of Bits reviewed Silence Laboratories'
`dkls23-rs` and `sl-crypto` repositories (report dated February 9, 2024, in
`github.com/silence-laboratories/dkls23`, `docs/`). The npm packages used here
are built from a different repository, `silent-shard-dkls23-ll`, which that
report does not list as a target; it shares the `sl-crypto` primitives at a
different revision. Treat the wasm as "from an audited family", not as the
audited artefact.

Not provided by this backend: adaptor pre-signing, key tweak, an explicit key
confirmation round, an integrity check on stored keys, and a durable
"this share is burned" rule (DKLs23 has no equivalent of the Lindell abort
rule; a failed session just aborts).

An experiment (`experiments/dkls-adaptor-feasibility.experiment.ts`) shows
that an adaptor pre-signature in our format _can_ be built on the unmodified
wasm, but only by reading secrets out of its serialised session and replacing
its last step with our own arithmetic. That is not a supported use of the
library and is not offered here.

### Licence of the silence-dkls backend

The two `@silencelaboratories/*` dependencies are **not** MIT. They are under
the "Silence Laboratories' Non-Commercial Use License Agreement" (`LICENSE.md`
inside each npm package; the same text is `LICENSE.md` in
`github.com/silence-laboratories/silent-shard-dkls23-ll`). This package's own
source is MIT; it does not contain their code, it depends on it.

Before distributing anything that contains the wasm (for example the built
web app), the licence asks, among other things, that recipients get a copy of
the licence and a notice with this sentence, the licence's list of conditions
and its disclaimer:

> This software library is licensed under the Silence Laboratories License
> Agreement, Copyright © Silence Laboratories Pte. Ltd. All Rights Reserved.

Whether a given use is "non-commercial" is, in the licence's words, "determined
by Silence Laboratories in its sole discretion". That is the owner's call, not
this README's. The backend can be removed without touching the game layer:
delete `src/silence-dkls/`, the two dependencies, and the one line that
chooses the backend.

## Installing the third-party packages

`package.json` pins `@silencelaboratories/dkls-wasm-ll-node` and
`@silencelaboratories/dkls-wasm-ll-web` at `1.2.0`, and `yarn.lock` has their
registry entries. Until `yarn install` has been run with them, tests can use a
copy installed elsewhere:

```sh
JOINT_SIGNER_DKLS_NODE_PATH=/path/to/node_modules/@silencelaboratories/dkls-wasm-ll-node \
  yarn test --runInBand
```

## In the browser

Not run in a browser yet. From reading the packages:

- Use the `-web` build through `load-web.ts`. It needs one asynchronous
  `init()` before first use, which fetches and instantiates a 642 KB `.wasm`
  (about 224 KB gzipped). Under Vite pass the asset URL explicitly:
  `import wasmUrl from '@silencelaboratories/dkls-wasm-ll-web/dkls-wasm-ll-web_bg.wasm?url'`.
- No `SharedArrayBuffer`, no threads, no cross-origin isolation headers, no
  top-level await. A Content-Security-Policy, if the app adds one, must allow
  WebAssembly (`'wasm-unsafe-eval'`).
- It works in a Web Worker the same way (the build uses `fetch`,
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

Keys and stored sessions do not carry over between backends: a stored key
names its backend and another backend refuses it (`invalid-key`). Swapping
means new keys, so do it between hands, with no funds at old joint addresses.

## Tests

`yarn test --runInBand` runs one conformance suite, unchanged, against both
backends: key generation, an EIP-1559 transfer signature that ethers recovers
to the joint address, refusal of garbage, duplicated, out-of-order,
other-session and altered messages, stored keys and sessions across a
simulated restart, the capability rules, and (where the backend has locks)
pre-sign, complete and extract.
