# Role keys

`@frank/role-keys` activates the [provisional D1–D11 schedules](../../docs/protocol/message-stamp-derivation.md) as a pure browser-compatible package. The only runtime exports are `deriveRoleLeaves`, `matchLocalRolePoints`, and `RoleKeyError`. No wallet, app, relay, bot or directory consumer is enabled.

```ts
const leaves = deriveRoleLeaves({
  authRoot, // DomainRoot<'identity-authentication'>, purpose 5
  messageRoot, // DomainRoot<'messaging-encryption'>, purpose 4
  stampRoot, // DomainRoot<'evm-wallet'>, purpose 2
  messageGeneration: 0n,
  stampGeneration: 1n,
  previousStampGeneration: 0n, // optional, explicit; grants no grace
})
try {
  const point = leaves.message.public.compressedPoint
  const output = leaves.message.useSecret(secret =>
    consumeSynchronously(secret),
  )
} finally {
  leaves.dispose()
}
```

Generations must be `bigint` in `0n..2147483647n`. Conversion to a number occurs only after that check; the public descriptor uses the resulting exact, JSON-safe number. Auth always uses local generation zero; there is no new wire field. Message and stamp generations are independent. Previous stamp must explicitly be current minus one; an omitted previous generation produces no previous property. This is a local consistency check, not evidence of authenticated prior membership or grace.

Every leaf exposes role, purpose, registry, exact path, generation and a copy-on-read compressed SEC1 point. There is no root, chain-code or xpub export, arbitrary-path interface, or identity-to-message conversion. Inputs are snapshotted; the operation never modifies caller buffers. Invalid root tags/lengths, unsupported generations, invalid exact-index derivation and role collisions throw `RoleKeyError`. An invalid child terminates the complete operation without returning partial leaves or trying another index. Programmer errors and throwing input getters may propagate their original exceptions; errors contain no package-added secret data.

`useSecret` lends a fresh 32-byte scalar copy for a **synchronous** callback, then wipes that copy in `finally`. Returning a Promise does not extend the borrow: an async continuation sees wiped bytes. The callback must not retain or copy secrets unless its own custody policy permits it; any deliberate copies belong to the consumer. A callback may derive its public output while the borrow is valid. Retained leaf scalars use private runtime fields and never appear in enumeration, JSON, or normal inspection. `dispose` wipes them, is idempotent, and permanently rejects further secret borrows. Public metadata remains available after disposal.

The package wipes owned seed snapshots and all HD nodes it receives on success and failure, and disposes earlier leaves if a later leaf fails. Buffer erasure is best effort: immutable arithmetic, library-internal copies, JS/runtime memory, swap, backups and copies made by consumers cannot be guaranteed erased. This is not hardware-backed or forensic erasure. Domain roots remain owned by the caller; the caller is responsible for their lifecycle.

```ts
const result = matchLocalRolePoints(
  input,
  {
    auth: suppliedAuthPoint,
    message: suppliedMessagePoint,
    stamp: suppliedStampPoint,
    // previousStamp: suppliedPreviousPoint, when explicitly present in input
  },
  suppliedExcludedPoints,
)
// Exactly { kind: 'local-point-comparison', matches: boolean }
```

A `true` result means only that explicit local derivations equal supplied compressed points, that supplied roles are separated including point negation, and that no point appears (including negation) in the optional supplied exclusion list. Malformed points throw; valid but wrong points, wrong generations, point collisions and mismatched previous presence return `matches: false`. Derivation errors throw. Matching creates and disposes its transient leaf set and returns no private capability.

The exclusion list is caller-supplied comparison data. It proves neither history completeness nor that points were ever authenticated or retired. A match authenticates no frame, T1, network, signature, anchor, freshness, linkage, current head, previous-key grace or rollback state. Consumers must separately obtain admission/persistence authority before use; there is intentionally no `verified` boolean or trusted-directory type here.

Tests compare all auth/message/stamp leaf bytes and internal HD chain-code results with the unchanged public synthetic proposal corpus. The unchanged TS/Rust proposal checkers independently preserve all 32 leaves and old account addresses. `check:boundary` bundles the public package against built public Nakamoto entrypoints, checks its dependency graph, and runs derivation/matching/disposal in a bare browser-like VM without Node globals. Never use these public test roots for funds.
