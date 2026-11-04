# Four typed owners in a matched native restore

These ignored library tests extend the existing synthetic large-value fixture.
They implement no backup service and change no production API or schema. Build
with the existing `backend/labs/Dockerfile.large-values`; its owner artifact is
`/large-value-owner-contract` (`cargo test --locked -p cashweb-registry --features
foundationdb --lib --no-run`). The old marker test remains, so no recipe change
is needed. Backend CI installs the7.3.63 native client; require actual native-feature
compilation and listing of the new tests, not just default-feature green checks.

Invoke one exact ignored test per process with `--ignored --nocapture
--test-threads=1 --exact`. For each module below the suffixes are `seed`,
`restored_read_only`, `replay_and_gc`:

- `store::directory_subjects::tests::matched_restore`
- `store::groups::tests::matched_restore`
- `store::forum::tests::matched_restore`
- `store::evm_direct_messages::large_request_tests::matched_restore`

Use the existing required `FRANK_LAB_RUN_ID`, `FRANK_FDB_CLUSTER_FILE`,
`FRANK_LAB_S3_ENDPOINT`, `FRANK_LAB_S3_BUCKET`, `FRANK_S3_ACCESS_KEY_ID` and
`FRANK_S3_SECRET_ACCESS_KEY`. There is no default cluster or endpoint. All owners
use `frank-large-value-lab:<run>:<production-suffix>/`, where the production
suffixes are directory-v1/groups-v1/forum-v1/messages-v4. One object client prefix
`lab-<run>/typed-owners` contains the owners' directory/groups/forum/messages
namespaces and their genuine claims. Source/target share logical identities,
while physical clusters, volumes, buckets/endpoints and generated keys differ.

Run all four seeds before quiescence. Complete the existing native backup and
full paginated same-read-version rawKV plus all-object/claim sealed-bundle gates.
Stop the source, restore to the empty distinct target and verify all bytes before
opening any typed owner. Run ALL FOUR restored_read_only phases before ANY replay
or GC. Their test-only native KV/object adapters panic on attempted set, clear,
atomic-add, put, conditional claim or delete; no swallowed failure can initialize
or repair restored state. Directory/Forum also open with create=false. Producer
rawKV/object comparison after the four reads is still required. Then run all four
replay_and_gc phases. Private orchestration must separately adopt this reviewed
new source/artifact binding; public044 artifacts cannot contain these tests.

Assertions:

- Directory: typed enrollment continuity/address/first-accepted indexes and local/
  replicated counters; inline/large forward bytes, content type, echo and queue
  facts; persisted expired claim takeover, refusal of stale/wrong holder,
  completed-answer replay and one-time released-body GC. A distinct live large
  forward retains its exact bytes and original reference before completion and
  after both sweeps while only the completed forward's object disappears.
  Continuity uses the recorder's real first=false authority, not an invented idempotent first commit.
- Groups: signed epoch/history and versioned write price, inline/large ciphertext,
  original signed receipt/sequence and consumed payment record; exact replay,
  payment and payer-nonce double-use refusal, next sequence and referenced-object
  retention while only abandoned uploads are swept.
- Forum: exact signed inline/large submitted frames, confirmed/pending observations
  and block/index facts, reservations/aggregate, pending bytes/count, revision,
  topic/discovery indexes and visible-post count; repeated admission/confirmation
  at changed999 returns and stores the original frame/state and confirmed visibility
  for both post and vote, reused-burn refusal and one-time pending settlement.
  Referenced frames survive GC.
- DM: inline and large enclosing requests and exact multipart content type,
  recipient/sender mailbox indexes/cursors with explicit ordered time/hash/direction
  tuples and exact first-cursor suffixes for both parties, delivery time,
  consumed-payment binding, exact retry, conflicting use refusal and monotonic next delivery. The
  messages_stored_total process metric resets on reopen; it is not a durable
  counter. Abandoned repeat/refusal uploads are collected once; committed bytes stay.

The added corpus uses64KiB+1 group bytes, two distinct64KiB+1 directory bodies,
a200KiB forum frame and roughly200KiB DM request. The previous8MiB DM/generic-intent/unindexed-object tests remain
required. Group ciphertext and forum frames do not invent a MIME attachment model;
Directory and DM preserve the content types their actual models own. Synthetic
canonical monad-testnet/10143 facts use existing signed test builders: no real
funding, live chain settlement or monad-regtest/20143 identity claim.

Ignored/compiled tests do not prove runtime restore. The intermediate in-run
native predecessor passed actual41857490736; its downloaded exported bundle failed
a separate hidden-file transport gate, which remains required and must not be
reconstructed into a pass. New actual execution requires reviewed/landed public
source, private artifact binding/orchestration and a distinct grant. Full financial/
custody/session-secret recovery, original452, full relay journeys and physical HA
remain separate gates. No production schema/parser/crypto/compatibility machinery
is added here.
