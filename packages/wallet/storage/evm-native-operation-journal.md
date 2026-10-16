# Native operation journal version 2

`EvmNativeOperationJournal` owns native member signed bytes, exposure, accepted
observation/account evidence, sync acknowledgement and account/nonce claims. The
manifest and every operation row require `version: 2`. Every member requires
`observationGeneration`, a nonnegative safe integer initialized to zero for a new
plan. No wire, key derivation, message or swap format changes here.

An accepted semantic change of observation or account advances the member's
generation in the same durable row write. The stable field projection ignores
object property order. Identical evidence, signing, exposure and sync
acknowledgement alone do not advance it. Discarding an unexposed operation also
advances generations where it clears observation/account evidence. Reservation
capacity includes the largest safe integer's encoding. A changing observation
at that maximum fails with `capacity` before writing; it cannot wrap.

A capture binds its owner lifetime, signed identity, evidence projection and
generation. The coordinated mutation reloads the durable row and compares all
of those before accepting any observation state. Thus A → B → exact A rejects a
capture taken before B, including across reopen of another wrapper. An unrelated
member or acknowledgement does not invalidate it. Rejection does not write the
row. The caller must make a new capture and obtain new network evidence; the
consolidator's observer never recaptures to reuse a rejected RPC answer. This
orders locally accepted evidence, not RPC truth or chain finality. Head-driven
reorg reconciliation remains a successor.

## Release gate and reversal

The physical component remains `evm-native-operations-v1` and operation IDs retain
their existing spelling. The explicit row/manifest versions determine the
format. There is no alternate namespace, migration, compatibility reader,
missing-counter default or automatic reset. Unsupported version 1 and malformed
version 2 records cause opening to fail before any application row or manifest
is changed. Signed/pending records and their claims remain on disk.

**Do not deploy this breaking format until the owner has explicitly decided the
disposition of existing journals, including funded and pending operations.** No
such disposition or deletion is authorized by this change. Development tests
use only new synthetic temporary namespaces; this is not a reset procedure for
existing wallet state. Retain old private state unchanged pending that decision.

Before any version 2 state is persisted, reversal is a source revert. Afterwards,
retain version 2 records as well: source reversal alone cannot safely resume them
with a version 1 reader and does not authorize deletion or rewriting. Ambiguous
writes poison the current owner; reopen validates actual durable evidence and
generation together, preserving exposure and reservations.
