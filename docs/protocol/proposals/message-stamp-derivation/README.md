# Message and stamp derivation preview proposal

Status: **PROPOSED — NOT ALLOCATED, NOT ACTIVE**. Issue [#734](https://github.com/schancel/frank/issues/734), base `d11773555cdfccf1bd811654da819176e4803baf`.
The owner authorized choosing provisional constants for the no-real-users preview.
Independent protocol/security review and @schancel/coordinator disposition must
precede active implementation. Merging these isolated artifacts does not accept
the choices, activate a writer, complete #696, or unhold #258.

This fulfils the [#719 successor contract](../suite1-directory/derivation-successor.md).
Its usable seam is an explicit public role tuple coupled to an independently
authenticated, exact directory frame/T1. It allocates no domain purpose, codec,
recovery format, capability, or generic key-manager interface.

## Proposed choice register

Every row is provisional. The owner has selected purpose 2 for the stamp root;
the precise child schedule and wallet behavior still need review.

| ID | Exact choice | Reason and consequence |
| --- | --- | --- |
| D1 | Preserve `codex32-master-v1` / code 1 and `frank-domain-roots-v1` / code 1, all five purposes and existing HKDF bytes | Existing recovery material continues to mean the same thing; no purpose 6 |
| D2 | P/auth: purpose 5, `m/44'/60'/1'/0/0` | Preserve reviewed identity bytes; the last two steps are a **preview exception** to main-spec §3.1's fully hardened clean target |
| D3 | M/message: purpose 4, `m/44'/60'/4'/0'/{g}'` | All five steps hardened; account component 4 distinguishes the message role visually as well as its separate root; fixed branch 0 is this schedule, not an extension registry |
| D4 | P'/stamp: purpose 2, `m/44'/60'/2'/0'/{g}'` | Owner-selected shared EVM root; separate account component 2 and full hardening isolate leaf exposure from spending siblings |
| D5 | `g = mailbox_key_generation` for M; `g = stamp_key_generation` for P'; both `0..2147483647` inclusive | Direct mapping, independent rotation; no integer rounding, modulo, probing, skipped index or identity fallback |
| D6 | Exact-index BIP32 with terminal failure at an invalid master/child | A directory generation must never silently refer to another derivation path; generic next-child retry behavior is unsuitable |
| D7 | No network input to HKDF/BIP32; network required for directory/T1 validation and restore | Preserve frozen roots and EVM paths; equal account and generation produce equal points across networks, intentionally linkable |
| D8 | Restore only from validated metadata and trusted, authenticated directory history; compare every derived public point exactly | Secret recovery alone does not establish freshness, authority, current generation or previous-key grace |
| D9 | Persist current/previous stamp pair; current-only degradation only after verified head survives and previous state is explicitly lost | Preserve S10a; no guess from seed search, no new grace based solely on a derived old key |
| D10 | Public exports contain role/purpose/path/generation/point plus exact directory frame/T1, never root bytes, private keys, chain codes or role xpubs | Narrow consumer seam; private/chain-code fixture fields are public synthetic evidence, not an export API |
| D11 | Reject any role collision including point negation, and any rotated point recurring in its own or another role's verified history | Hardened paths are distinct, not a mathematical guarantee of distinct curve points; collisions fail closed and do not trigger skipping |

## Exact derivation

The 32-byte decoded account root is HKDF input key material. Recovery decoding
and metadata authentication stay with their existing owner. There is no BIP39
mnemonic, password stretching, entropy reinterpretation, or additional hashing.
The entire derivation below is network independent.

```text
salt = ASCII("frank/domain-root-registry/v1")
PRK  = HMAC-SHA256(salt, account_root)
info = u16be(21) || ASCII("frank-domain-roots-v1") || u16be(purpose_code)
       || u16be(len(label)) || ASCII(label) || u16be(32)
root = HMAC-SHA256(PRK, info || 0x01)  // RFC5869, one 32-byte expand block
```

The frozen labels are `frank/domain-root/v1/` followed by, in code order:
`ecash-bch-wallet` (1), `evm-wallet` (2), `solana-wallet` (3),
`messaging-encryption` (4), `identity-authentication` (5). Each output is 32 bytes.
Purposes 1, 2, 4, 5 remain BIP32 secp256k1 master seeds; purpose 3 remains an
Ed25519 keypair seed and is never passed to this proposal's BIP32 role schedule.
`vectors.json` records the literal salt/info/PRK/output bytes for every purpose
and both public account roots: 32 zero bytes and ascending `00..1f`.

For each role, **the BIP32 seed is exactly the selected domain-root output**.
`m` means that seed's BIP32 master, not the account-root master and not an EVM
funding private key. BIP32 master expansion is
`I = HMAC-SHA512(ASCII("Bitcoin seed"), seed)`; `IL` is the first 32 bytes,
`IR` the final 32. `parse256(IL)` must be in `1..n-1`, where
`n = fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141` (hex).
The master private scalar is `IL`, chain code `IR`. Zero or `IL >= n` terminates
this schedule for that root. Do not hash/reseed, reduce modulo n, change purpose,
or search another master.

For a hardened component `j'`, serialize `i = j + 0x80000000` as exactly four
unsigned big-endian bytes. The CKDpriv HMAC key is the parent's 32-byte chain
code; the data is `0x00 || ser256(parent_scalar) || ser32(i)`. Leading zero
scalar bytes are retained. Child scalar is `(parse256(IL) + parent_scalar) mod n`
and child chain code is `IR`. Reject `IL >= n` before addition, and reject zero
child scalar. **IL = 0 is valid at the BIP32 primitive layer** if the child
scalar is nonzero. It is not permission to publish a repeated role point.
At a retained non-hardened auth/funding/change step, data instead starts with
the parent's 33-byte compressed SEC1 public point. These existing paths do not
become hardened by this proposal.

| Role | Serialized component prefix | Last component at g=0 / 1 / max |
| --- | --- | --- |
| M | `8000002c 8000003c 80000004 80000000` | `80000000` / `80000001` / `ffffffff` |
| P' | `8000002c 8000003c 80000002 80000000` | `80000000` / `80000001` / `ffffffff` |
| P/auth and EVM main, different roots | `8000002c 8000003c 80000001 00000000` | Fixed `00000000` |
| EVM funding pool | `8000002c 8000003c 80000000 00000000` | Non-hardened `00000000` / `00000001` / `7fffffff` |
| EVM change | `8000002c 8000003c 80000000 00000001` | Non-hardened `00000000` / `00000001` / `7fffffff` |

Branch separation holds for every allowed index: stamp diverges from the EVM
main account at hardened component 2 versus 1, and from funding/change at 2
versus 0. Auth and main share path text but use purpose-5 versus purpose-2 seeds;
M uses purpose 4, never either seed. Changing any existing EVM or auth bytes is
outside this proposal. The corpus checks the previous independently derived
wallet address answers in addition to new Rust private/public/chain-code answers.

All arithmetic is exact integer arithmetic. The JSON evidence uses canonical
unsigned decimal strings; `01`, `1.0`, JSON numbers, negatives and missing values
are rejected by its boundary parser. An active CBOR consumer would decode the
existing uint64 wire value as an exact integer, then apply this profile's bound;
it must not first convert it to a JavaScript number. `2147483648` is the first
unsupported generation. The directory grammar remains uint64; a valid remote
directory with a larger generation does not become malformed just because this
wallet cannot derive it. Return an unsupported-local-schedule result and disable
the corresponding local receive/open/publish operation, without substituting keys.

An invalid child at **any** step aborts the entire requested derivation. No
partial role tuple, generation publication or rotation-state mutation may escape.
Retrying unchanged bytes deterministically returns the same failure; no automatic
retry policy can repair it. Invalid fixed prefixes make this schedule unavailable;
an invalid generation leaf or a role-point collision prevents that rotation.
Current accepted keys remain current. Never advance past the failed generation.
At max, retaining the current generation and unrelated directory renewal remain
possible, but rotating that role requires a separately reviewed migration. There
is no wrap to zero and no cross-role index reuse. Synthetic HMAC injection covers
zero/invalid masters and invalid/zero children at first and last hardened indices;
an injected zero tweak also checks the valid primitive boundary. No fixture needs
real keys or a naturally occurring 2^-128-scale BIP32 invalid-child event.

## Restore and admission contract

Before any local key operation, the future consumer validates exact recovery
format/registry IDs and codes, purpose, interpretation and 32-byte root length.
Purpose-tagged bytes alone are not cryptographic provenance: a relabelled secret
fails the public-point comparison with the independently authenticated directory.
No imported xpub, foreign path, non-hardened M/stamp path, auth/EVM-as-message
point, funding-as-stamp leaf, or inferred role is accepted.

The trusted input is the [directory proposal's](../suite1-directory/README.md)
verified fresh head, exact type-4 frame and T1, network/subject anchor, contiguous
authenticated predecessor history, and atomically retained generations and
current/previous state. Signature/link/freshness/fork/budget validation happens
there; this derivation proposal does not replace it. Explicitly validate:

1. Recompute T1 over the exact complete frame under its validated network; never
   hash a projection or use the type-2 wrapper hash. Extract role points and
   generations from those same authenticated bytes.
2. Derive P at the fixed auth path and require exact compressed SEC1 equality
   with the subject. Derive M and P' at the recorded respective generations;
   require exact equality with fields 10 and 8. Check point validity and
   x-coordinate role/history separation, including negated-point collisions.
3. The head's generations are independent and never inferred from revision.
   An unchanged point has unchanged generation; a rotation advances that role
   exactly once. Unknown/missing/mismatched generations fail closed. Do not scan
   seeds against arbitrary relay records until a plausible point is found.
4. Restore previous P' only from authenticated contiguous rotation state. Under
   this zero-based contiguous schedule, its recorded generation is current−1
   after at least one rotation, otherwise null. Independently derive it and
   compare its point with the retained prior-rotation statement. A renewal or
   M-only rotation preserves it. A supplied but contradictory pair is an error.
5. If a trustworthy fresh head and rollback protection survive but previous
   state is explicitly lost, S10a permits **current only, previous null**. Do
   not derive current−1 and grant it grace merely because the seed permits it.
   Restore verified history before restoring grace. Losing the head/anchor or
   rollback protection blocks new use pending external re-anchoring; possessing
   a seed or an old directory alone cannot pick the current head.

Commit derived-role ownership and verified directory/rotation state atomically
before exposing a newly published tuple. Failed restore/rotation leaves the last
accepted state untouched. Persistence crash consistency, trusted clocks, actual
secret handles and directory authentication are downstream implementation gates,
not capabilities claimed by these fixture runners.

S10a permits current or immediately previous P' for new stamped-message admission
subject to all directory/message checks. There is no expiry timer or revision
count that clears previous. After compromise, **two distinct rotations** remove
that point; one leaves it admitted as previous. New authoring uses the fresh
head's M and P'. A still-valid in-flight older recipient statement is usable only
when its M remains current and its P' is current/previous. An M rotation gives
retired M no new-use grace. Old M and stamp secrets retained for archive opening
or outstanding spending obligations grant no directory, mailbox or new admission
authority. Explicit archive opening requires the historical authenticated frame
and matching retained M, and produces only an archive result.

The proposal leaves target current-only stamp admission after provider-effective
capability installation and target bounded M grace unimplemented. Those need
capability allocation, provider fencing and authenticated migration policy; this
preview's S10a state must not be presented as those target guarantees.

## Secret and public boundaries

The future wallet owns account/domain-root buffers and private derivation work.
It snapshots caller-owned input and must never wipe or mutate the caller's
buffer. Each operation owns its PRK, copied seed, parent/child scalars and chain
codes; release transient copies in a `finally`/RAII-equivalent path on success
and failure. Keep retained secrets only in wallet/archive/spend custody as
required by outstanding obligations. Destructive retirement requires separate
user policy. Best-effort buffer wiping cannot erase immutable BigInts, library
copies, runtime memory, swap or backups; it is not forensic erasure. These
standalone runners deliberately retain **public synthetic** material for review
and make no production secret-erasure claim.

Never export a role-level xpub or chain code, publish root material, or let the
messaging/relay side accept a generic signing secret in place of a role-bound
public tuple. The allowed public seam is:

```text
(recovery/registry profile, role, purpose, exact path, exact generation,
 compressed SEC1 public point, network, exact authenticated type4 frame, T1)
```

Auth is fixed-generation 0 only in this local evidence profile; it does not add
an auth-generation wire field. A consumer must obtain authentication/validity
evidence from the directory boundary separately, never a caller's `verified`
boolean. The eight included frame/T1 examples are **unsigned construction
fixtures**; they do not themselves establish a trusted directory or a live relay.

No forward secrecy is introduced: retained deterministic roots can rederive
past M and stamp secrets, and static M compromise exposes affected ciphertext.
The EVM root intentionally shares the compromise domain of EVM main, funding,
change and all stamp generations. Fully hardened child derivation limits a
stamp-leaf leak; it does not protect funds from an EVM-root leak, nor protect
any domain from an account-root leak. Under existing T3a, a leaked payment-child
secret together with the corresponding frame can expose that generation's
stamp secret, affecting its stamped funds and S10a grace until two rotations
converge. The hardened EVM ancestor, funding siblings and independent P/M roots
are not thereby revealed. This is a stamp **branch**, not a dedicated stamp root.

## Shape, ownership and next stages

Current durable shape is five immutable root purposes plus existing auth/EVM
paths; active messaging still awaits #696's role-separated cutover. Proposed
shape adds only deterministic child schedules and a recorded public tuple tied
to exact directory state. The known next work is active codec/schedule allocation,
then wallet restore, seal/open, sender/recipient directory resolution, relay and
payment integration, and legacy identity fallback/writer deletion in #696. A
generic key manager, recovery GUI, new root registry and federation framework
would add unrelated interfaces and are deliberately absent.

@schancel/coordinator owns provisional choice disposition and successor dispatch.
The implementation worker owns these isolated artifacts; independent reviewers
own protocol/security findings. No active package imports this tooling. Before
activation, rollback is deletion of these three proposal directories; after
activation a derivation change would require migration. #696 remains open until
its active integration and legacy deletion proof land. See [fixtures.md](fixtures.md)
for exact gates and the limits of their evidence.
