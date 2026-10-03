# Dispatchable successor proposal contract for #696

Status: **PROPOSAL AUTHORING AUTHORIZED; ALLOCATIONS NOT ACCEPTED**.
The owner's latest direction permits provisional derivation/DM constants for
testable preview work, followed by independent protocol/security review. This
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
| P'/stamp | No purpose is currently allocated | Propose a new independent purpose, metadata/version transition and hardened child schedule; never borrow purpose4/5/2 |
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

1. New stamp-purpose numeric code, exact ASCII label, length and BIP32 seed
   interpretation. Code 6 / `stamp-receipt` is a candidate to evaluate, **not
   an allocation in this document**. Preserve all existing rows' byte outputs.
2. Exact recorded registry revision/profile migration permitting that purpose.
   The frozen registry says an account may derive only purposes in its recorded
   registry version. A new row cannot silently broaden already-recorded v1
   account authority. Merely changing `registry_id` would change all existing
   HKDF outputs, so reconcile the metadata transition with unchanged EVM/auth
   roots and prove old readers reject new required semantics. If impossible
   under current recovery metadata, explicitly propose a new account/recovery
   format and make that migration a separately approved predecessor.
3. Message/stamp child path grammar, hardened purpose/branch indices and bounded
   rotation index. Choose whether each uint64 directory generation maps directly
   into multiple hardened limbs or is capped by a smaller preview schedule;
   no truncation, modulo, floating-point conversion or inferred index. The
   directory generation is a sequence, not already a derivation allocation.
4. Precise BIP32 master/child invalid-scalar behavior and index exhaustion.
   Never skip into another purpose, silently shift a published generation, or
   let two generation values derive the same key. Failure/retry semantics need
   exact vectors, including injected invalid-child results where natural
   examples are impractical.
5. Seed/registry/rotation restore validation: exact public point must match the
   authenticated directory tuple. Missing or contradictory history fails closed.
   Restoring retired message/stamp secrets must not grant new admission rights.
6. Secret ownership/wiping and public-export boundary. No role-level xpubs,
   cross-role child derivation or parent/root reuse. Best-effort wiping is not
   forensic erasure. Describe the stamp-child leak consequence from T3a/S10a.

## Acceptance and proof

The proposal must include exact HKDF inputs/outputs, BIP32 seeds and serialized
path components, private/public child outputs and corresponding directory
generation tuples for public test roots `00..00` and `00..1f`. Cover initial,
next, highest accepted and first rejected generations; distinguish network
handling explicitly. Use independent TS and Rust derivation libraries/checks;
produce shared positive/hostile vectors, not assertions generated by only the
same helper under test. Secrets in this corpus are public synthetic test data.

Prove existing five domain-root outputs, EVM fund/change paths and the reviewed
auth path remain byte-identical. Reject wrong purposes, auth/EVM-as-message,
stamp-as-message, wrong registry metadata, non-hardened supplied paths, index
overflow, missing rotation state and mismatched derived directory points.
Preserve S10a current/previous stamp handling and independently derive both
when restoring; two rotations close the compromised previous-key window.
Document the no-forward-secrecy limitations and target capability dependencies.

Required gates: isolated proposal TS typecheck/fixture/format, independent Rust
locked offline fixture/format, unchanged-root/path known-answer checks and
scope diff. Required downstream seam: #696 can consume an approved explicit
tuple `(purpose profile, hardened path, generation, public point)` together with
the exact validated directory frame/T1, without legacy identity fallback.

The known successor is separately reviewed active registry/codec allocation,
then #696's wallet/send/open/relay/payment cutover and legacy-writer removal.
No generic key-manager framework, public federation, recovery GUI or capability
allocation is needed. Delete proposal directories to roll back before acceptance;
after activation, changed derivation would require migration, so no activation
is authorized by this contract. Handoff exact tip/base, choice register, vectors,
gates, unresolved decisions and requested/actual model. A draft PR is permitted;
merge, closure and declaring provisional choices accepted are not.
