# Proposal fixture contract and gates

These files are outside the active normative manifests. They are evidence for
review, not an allocation or production validator. Fixed private scalars 1..8
are public test material only; the relay at `relay.example.invalid` is a
synthetic, explicitly passed trust fixture. No test contacts it or spends funds.

`vectors.json` has format `suite1-directory-proposal-v1` and status
`PROPOSED-NOT-ALLOCATED`. All hex is lowercase with no prefix. Wire integers are
canonical CBOR integers; JSON counter/time context values are exact decimal
strings. `frozen_sha256` pins the listed active artifacts to the proposal base;
regeneration is not permission to change those artifacts or silently repin them.

Each `records` entry contains complete `type4_hex` and `type2_hex`, the exact
type-4 `t1` and `t2_digest`, and two deliberately separate assertions:

- `signature_valid`: algorithm-1 verification against the wrapper's signer.
  This alone does not prove that signer equals P or that the statement is valid.
- `old_reader`: the observed active codec's full type-2 outcome with its default
  reader-2/schema-3 support and null prior state. `accept` for old schemas or
  a dishonest lower-floor record does not mean suite-1 roles were interpreted.

The well-formed proposed schema4/min4 record is `unsupported` in both active
codecs. The `wrong-reader-floor` record intentionally advertises schema4/min2:
old readers may safely understand only their old projection under frozen V6.3,
while the proposal reader rejects it. An attacker cannot strip a genuine
record's reader floor without invalidating its T2 signature. An authorized
signer can lie about its own minimum reader; old readers cannot infer unallocated
semantics, and their acceptance must never be claimed as suite-1 support.

Each `cases` entry has a unique `id`, `operation`, ordered `history` IDs, and
an `expected` proposal outcome. History is previously verified contiguous
same-subject state, not data a remote caller is allowed to assert. The TS runner
independently checks every listed history prefix before using it. Directory
cases reference a signed record. At bootstrap, `anchor` is a separate explicit
trusted test input, even when it equals that record's T1. Null means no trust
anchor; the runner must not infer one from received bytes.

Defaults for the offline context are network `monad-testnet`, trusted clock
`1700000100` seconds, reader 4, and the explicit `synthetic_relay_cbor_hex` tuple
stored in the manifest. Individual cases override `network`, `clock`,
`last_clock`, `reader`, `relay`, `claimed_t1` or `anchor`; null clock/relay means
missing trust input. Production callers would have to supply these explicitly.
Outcome labels such as `generation`, `fork` and `binding` identify the tested
proposed policy; they are **not** additions to active codec error categories or
a new frozen validation-stage order.

`stamp` cases supply a candidate point and history-derived current/previous
pair. `restart: pair-lost` deliberately reconstructs current only; `head-lost`
disables use. These model S10a state policy, not persistent storage crash tests.
`message` cases select an exact verified tuple. New authoring requires the
current exact head; `in_flight: true` permits a still-valid historical tuple
only if M is current and P' is in the current/previous S10a pair. Both message
admission and `stamp` checks require the current head to be fresh, even when
the selected older record has a later expiry. `archive: true` is separate from
new admission. These cases do not encrypt, route, open a mailbox, or verify
a real delivery; `archive-only` grants no admission. `counter` cases are pure
uint64 terminal-boundary examples, not a claim to have generated 2^64 updates.
The last value can be retained unchanged; an increment at max is rejected.

`advance` cases pass an ordered `candidates` list and explicit current clock
to the atomic catch-up reference. Expired intermediates receive complete
historical-link authentication but no standalone acceptance. Only a fresh,
currently trusted terminal head commits. `committed_history` and
`previous_stamp` assert exact success/failure state: a failed transaction must
leave both unchanged, including an already populated previous-stamp slot.
The first contact still requires the separately supplied exact rev0 anchor.
Cases cover offline rev0 → expired rev1 → fresh rev2, late first contact,
missing links, bad historical signatures/generations, expired or untrusted
terminal state, and failed-state preservation. No historical acceptance time
is invented to make an expired intermediate pass.

`history-budget` cases exercise the exact cumulative cap using previously
validated accounting inputs `stored_count`/`stored_bytes` and batch inputs
`incoming_count`/`incoming_bytes` (decimal strings). The same budget function
guards the whole `advance` batch before candidate decoding and each directory
extension. Caps are 4096 statements and 16777216 bytes; charged bytes include
both the exact type4 frame and its type2 wrapper. Boundary probes do not claim
to construct thousands of accepted revisions; normal catch-up fixtures charge
their actual retained/candidate bytes. Real persistence and conflict-evidence
accounting remain production-boundary obligations for the allocation stage.

The Rust `rust-origin.json` is a separately constructed complete bootstrap
wrapper. Type-4 bytes and T1 are identical to TS; the libraries' deterministic
signature conventions can give different valid wrapper bytes. TS verifies the
Rust signature, and Rust verifies every TS signature. The wrapper hash is never
used as a statement commitment. This does not mandate a nonce convention on
the wire; strict DER, low-S, and valid ECDSA are the frozen requirements.

| Coverage | Concrete cases | TS | Rust |
| --- | --- | --- | --- |
| Exact canonical type4/type2, T1/T2, complete signatures | All 55 frame pairs; independently built bootstrap wrapper | Generate + check | Independent codec/hash/signature + bootstrap generation |
| Required-key, type/point and role separation | missing auth/M/stamp, wrong type, invalid point, equal/negated roles, historical swaps | Policy outcomes | Bytes/crypto only |
| Network, commitment, signer and signature | wrong network/hash/signer/signature, type2-hash predecessor | Policy outcomes | Hash/signature independently checked |
| Updates, generations, predecessor, clock, fork and bootstrap | renewals, independent rotations, skipped/unchanged generation, historical fork, rollback, missing anchor/clock | Policy outcomes | Bytes/crypto only |
| Atomic historical catch-up | offline and late-contact acceptance; missing/invalid links, terminal freshness/binding and unchanged failure state | 10 transaction outcomes | Every supplied frame's bytes/crypto |
| Cumulative history budgets | count and byte boundary acceptance/rejection, oversize batch | 5 budget probes + actual transaction charging | Not implemented |
| uint64 terminal behavior | last increment, wrap, increment at max, unchanged max | Boundary outcomes | Not implemented |
| S10a grace and restart | current, previous, two rotations, renewal, recovered/lost pair/head | State outcomes | Not implemented |
| Message retirement and grace | current new use, retired M, old P' after two rotations, immediate previous P', stale head, archive-only | Tuple policy | Not implemented |
| Version/cross-schema behavior | old schemas2/3, reader2, wrong floor, future required, optional projection, schema downgrade | Old reader + proposal outcomes | Independent old reader |
| Retained optional bytes | future field100, tamper retaining original signature, exact full-frame checks | Bytes + signature rejection | Canonical bytes + signature rejection |
| Frozen baseline | Seven active artifact SHA-256 values | Check | Independent check |

There is no `scripts/factory/gates` entry point in this base. From repository
root with its existing Node dependencies installed, the bounded equivalent
stages for this proposal are:

```sh
# Proposal typecheck and deterministic generation/semantic fixture gate
node_modules/.bin/tsc -p packages/frank-codec/proposals/suite1-directory/tsconfig.json
node packages/frank-codec/proposals/suite1-directory/run.cjs

# Independent Rust byte/hash/signature/legacy-reader gate, locked and offline
cargo run --offline --locked --manifest-path backend/cashweb/frank-cbor/proposals/suite1-directory/Cargo.toml

# Formatting for the two isolated harnesses
node_modules/.bin/prettier --config app/.prettierrc.json --check packages/frank-codec/proposals/suite1-directory
cargo fmt --manifest-path backend/cashweb/frank-cbor/proposals/suite1-directory/Cargo.toml -- --check

# Scope/whitespace check; only the three proposal directories may differ
git diff --check
git diff --name-only 2f2ae5bfda5b23b48d2b42fcac6fdf0802ecaeb4
```

To deliberately regenerate reviewed fixtures: run the TS command with `--write`,
then the Rust command with `-- --write`, then both check commands normally.
Review the complete byte/outcome diff. The TS policy runner is intentionally
bounded to this corpus: it is not a hostile-input-ready replacement for the
active validator, aggregate resource metering, persistence, clock service or
relay trust provisioning. CDDL structure is supplied for review; these runners
do not compile CDDL. The future active allocation stage must add both language
state validators and full production-boundary conformance before activation.

No workflow, package entry point, active schema registry or conformance manifest
imports these files. `run.cjs` builds the TS harness in memory only. The Rust
harness is its own opt-in workspace; its build output is ignored locally.
