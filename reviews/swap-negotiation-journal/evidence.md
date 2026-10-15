# S5c1 candidate evidence

Dispatched start: `925070a9cef6385471201e8e91a380920ae2831f`; root-only
contract clarifications: `ae67f577` and `38667dd5`. Requested lane: GPT-6.1 Sol
medium (runtime model identifier is not independently exposed).

## Result and successor seam

New separate `negotiation-journal` entry owns one immutable-context evidence row,
strict schema/admission/reconstruction and CAS retry logic. The existing S5a core,
transport plugin, wallet, hosts, dependency manifests and formats remain unchanged.
There is no concrete storage, production memory fallback, financial authorization,
clock, signing, funding, pruning or reset API.

Facade: `NegotiationJournal({ owner, context, store })`, deterministic `.rowKey`,
fresh `.read()` and authenticated `.admit(...)`. The delivery assertion explicitly
includes messagingChainIdentifier; duplicates still authenticate before returning.
The row stores that chain once in its owner. Distinct signed conflicts remain in
the original-byte evidence array and force S5a's usableAcceptance to null.

The root-approved pure `inspectNegotiationJournalRecord(raw)` shares strict schema,
context/key derivation, authentication and reduction with the engine. It returns
copied owner/context/evidence/reduction and rowKey. It assumes no expected host
owner: adapters MUST compare incarnation/local key/requested key explicitly. Tests
prove malformed refusal and returned-value mutation isolation. Qualified concrete
CAS adapters and atomically enforced account-wide row limits are required successors;
then authenticated host polling/streaming/outbound replay and lifecycle/retention.

## Gates

| Command from repository root | Result |
| --- | --- |
| `node_modules/.bin/jest --config packages/swap-protocol/jest.config.cjs --runInBand` | 5 suites, 62 tests passed |
| `node packages/nakamoto/scripts/check-deps.mjs --root packages/swap-protocol` | Declared dependencies match: 2 runtime, 0 optional |
| `node_modules/.bin/prettier --single-quote --no-semi --trailing-comma all --check packages/swap-protocol/src/negotiation-journal.ts packages/swap-protocol/src/negotiation-journal.jest.test.ts` | Both new source/test files pass |
| `yarn typecheck:fast` | 23 configured projects checked, 23 passed, 0 failed |
| `git diff --check` | Passed |

The co-located test enforces the production import allowlist and verifies the core
entry does not install the new journal. Signed tests use real existing identities,
plus a deterministic alternate low-S signature to prove distinct valid signed bytes
remain evidence while S5a decides semantic duplication. Test-only MemoryCas commits
comparison+write at one synchronous linearization point; this is algorithmic evidence,
not backend or physical durability qualification.

Coverage includes offer/accept/reject and orphan buffering, reorder/repeat delivery,
first metadata retention, conflicting offers/decisions, both local parties/directions,
wrong chain/local identity/conversation/party/swap/signature, wrong-chain duplicate
no-write, strict malformed/unknown/oversized stored records, immutable binding checks,
64 entries without eviction and duplicate at capacity, racing independent instances,
eight-attempt contention, read/CAS failure identity, commit-then-throw and reopen retry,
Buffer mutation across delayed reads/CAS, and returned aliases. No external/funded calls.

## Golden vectors and exact format

The README documents exact JSON fields and twelve u32-BE-length-framed key components.
For incarnation `incarnation-a`, local party A (secret scalar1 public key), messaging
chain `monad-testnet`, swap ID `11` repeated32 bytes, conversation `22` repeated16,
ordered scalar1/scalar2 public keys and testnet policy, independent Python hashlib
framing produced:

```text
0095bc9b284097d543066203c099f158ef8e800f3097f7c30dace06c4c96e1cc
```

The test pins that key, exact normalized JSON field ordering/content, and SHA256 of
the signed-offer record:

```text
40af427fdb183e11152fe892c2bfeab6cfa9b0ab0aa19f3aba461fd1820de045
```

## Limits and residual risks

CAS durability, committed reads and cross-handle linearizability are injected host
obligations; no installed adapter is claimed. Storage exceptions are never retried
or interpreted as absence. Local delivery metadata remains trusted application state;
this engine cannot establish outer-envelope provenance, prevent hostile local mutation
or rollback, or decide reset-resistant financial recovery. Account incarnation policy,
pre-activation history, per-account capacity/retention and host revocation remain
explicit successor contracts. Independent review/integration is still required.

Temporary dependency overlays preserved installed package-local versions and resolved
`@frank` to this candidate. Only those owned overlays are removed after verification.
