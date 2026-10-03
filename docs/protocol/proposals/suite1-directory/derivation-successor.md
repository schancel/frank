# Dispatchable successor proposal contract for #696

Status: **PROPOSAL AUTHORING AUTHORIZED; ALLOCATIONS NOT ACCEPTED**.
The owner has selected existing `evm-wallet` purpose 2 for a bounded preview
stamp branch, with an explicitly allocated fully hardened S10a child schedule.
P and M use their distinct existing auth/message domain roots. No new domain
purpose or registry/recovery-format migration is needed or authorized. Exact
child constants and vectors still require independent protocol/security review. This
is the bounded successor option to #719's directory proposal, not a hidden
extension of the active registry. It is intentionally a contract and decision
list, not a partial derivation allocation without vectors.

Owner: @schancel / coordinator. Parent [#696](https://github.com/schancel/frank/issues/696).
Tier 3, strong lane, repository-only. Implementation ownership begins with a
new exclusive claim after coordinator dispatch. Review and integration remain
independent. Do not modify #716's claimed identity files or activate #258.

## Outcome and boundary

Produce a separately labelled derivation proposal and complete deterministic
vectors that let a later wallet restore independent P, M and P' from recorded
Codex32 domain-root metadata plus validated rotation state. Current code's
identity-as-DH/stamp and synthetic directory hash are not valid substitutes for
this result or for #719's exact type-4 T1 commitment.

| Role | Frozen root ownership | Successor work |
| --- | --- | --- |
| P/auth | Purpose 5, `identity-authentication` | Preserve allocated auth root and existing fixed child path; document preview-versus-target hardening distinction |
| M/message-DH | Purpose 4, `messaging-encryption` | Allocate a dedicated, bounded, fully hardened child schedule; never use auth or EVM roots |
| P'/stamp | Owner-selected existing purpose 2, `evm-wallet`; no dedicated stamp domain-root purpose | Allocate the separate fully hardened S10a branch below this root; never reuse an EVM funding/change key or auth/message key |
| EVM funds/change | Purpose 2, `evm-wallet` | Preserve all existing roots and spend/change paths byte-for-byte |

At #719's base the fixed auth path is `m/44'/60'/1'/0/0`; #716 owns its typed
root migration. Preserve the finally reviewed #716 auth behavior rather than
changing its path incidentally. Main-spec §3.1's fully hardened clean target
is a separate compatibility question: retaining that path must be labelled a
preview exception, never described as already satisfying the clean target.

Allowed successor artifacts: `docs/protocol/proposals/message-stamp-derivation/`,
`packages/domain-roots/proposals/message-stamp-derivation/`, and a matching
standalone Rust proposal checker under
`backend/cashweb/frank-cbor/proposals/message-stamp-derivation/`. No edits to
active registry, its existing vectors/API, wallet/runtime validators, manifests,
protocol CDDL or production build/dependency files. Existing generic derivation
and crypto libraries may be used read-only by isolated tooling. No live keys,
services, accounts or funds. No import from proposal tooling into production.

## Decisions the strong author must concretize

1. Freeze the owner-selected stamp root mapping: BIP32 seed bytes are exactly
   the existing purpose-2 HKDF output. Preserve all five frozen roots' inputs,
   labels, codes, registry identifier and byte outputs. Do not add purpose 6,
   change recovery metadata, or substitute an EVM leaf private key for the root.
2. Explicitly allocate the S10a candidate path
   `m/44'/60'/2'/0'/{rotation}'` **relative to that EVM domain root**, with every
   component hardened and `rotation` bounded to `0..2147483647`. This successor
   must confirm branch non-overlap with existing `m/44'/60'/0'/0/i` funding and
   `m/44'/60'/0'/1/i` change paths and preserve their outputs. The root mapping
   is an owner decision; this exact child-path/bound proposal is not frozen by
   the directory draft and requires the vectors and review below.
3. Allocate a separate fully hardened M child grammar below existing purpose 4.
   State the exact mapping of directory generation to child rotation: for the
   bounded stamp candidate use `rotation = stamp_key_generation` only inside
   the supported range and fail closed above it. No truncation, modulo,
   floating-point conversion, silent key-search or reuse of the auth/EVM root
   for M. The directory's uint64 sequence does not imply all generations are
   derivable by every preview wallet. Existing roles and directory wire bounds
   must not be silently changed to conceal the wallet's narrower schedule.
4. Precise BIP32 master/child invalid-scalar behavior and index exhaustion.
   Never skip into another purpose, silently shift a published generation, or
   let two generation values derive the same key. Failure/retry semantics need
   exact vectors, including injected invalid-child results where natural
   examples are impractical.
5. Seed/registry/rotation restore validation: exact public point must match the
   authenticated directory tuple. Missing or contradictory history fails closed.
   Restoring retired message/stamp secrets must not grant new admission rights.
6. Secret ownership/wiping and public-export boundary. No role-level xpubs,
   stamp/auth/message public-point reuse or non-hardened stamp branch. Sharing
   the purpose-2 root intentionally shares its compromise domain with EVM
   funds, while the fully hardened branch prevents a leaked stamp leaf from
   revealing parent or funding/change siblings. Best-effort wiping is not
   forensic erasure. Describe the T3a/S10a stamp-leaf leak consequence and this
   preview root-compromise tradeoff explicitly; it is not a dedicated stamp root.

## Acceptance and proof

The proposal must include exact HKDF inputs/outputs, BIP32 seeds and serialized
path components, private/public child outputs and corresponding directory
generation tuples for public test roots `00..00` and `00..1f`. Cover initial,
next, highest accepted and first rejected generations; distinguish network
handling explicitly. Use independent TS and Rust derivation libraries/checks;
produce shared positive/hostile vectors, not assertions generated by only the
same helper under test. Secrets in this corpus are public synthetic test data.

Prove existing five domain-root outputs, EVM fund/change paths and the reviewed
auth path remain byte-identical. Include exact purpose2 stamp vectors at rotations
0, 1 and 2147483647, and rejection at 2147483648, plus the chosen M schedule's
equivalent boundaries. Reject wrong purposes, auth/EVM-as-message, an existing
EVM leaf reused as P', stamp-as-message, wrong registry metadata, non-hardened supplied paths, index
overflow, missing rotation state and mismatched derived directory points.
Preserve S10a current/previous stamp handling and independently derive both
when restoring; two rotations close the compromised previous-key window.
Document the no-forward-secrecy limitations and target capability dependencies.

Required gates: isolated proposal TS typecheck/fixture/format, independent Rust
locked offline fixture/format, unchanged-root/path known-answer checks and
scope diff. Required downstream seam: #696 can consume an approved explicit
tuple `(purpose profile, hardened path, generation, public point)` together with
the exact validated directory frame/T1, without legacy identity fallback.

The known successor is separately reviewed active child-schedule/codec allocation,
then #696's wallet/send/open/relay/payment cutover and legacy-writer removal.
No generic key-manager framework, public federation, recovery GUI or capability
allocation is needed. Delete proposal directories to roll back before acceptance;
after activation, changed derivation would require migration, so no activation
is authorized by this contract. Handoff exact tip/base, choice register, vectors,
gates, unresolved decisions and requested/actual model. A draft PR is permitted;
merge, closure and declaring provisional choices accepted are not.
