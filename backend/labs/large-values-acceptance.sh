#!/bin/sh
# Large-value store acceptance (HA plan step 4) against real FoundationDB and real MinIO.
# Run from the repository root of an isolated worktree:
#   COMPOSE_PROJECT_NAME=frank-lab-large-values-$USER backend/labs/large-values-acceptance.sh
# Everything runs in this Compose project's own network and volumes, and the project is
# removed with --volumes on exit. Set FRANK_LAB_KEEP=1 to keep it for inspection.
set -eu
: "${COMPOSE_PROJECT_NAME:=frank-lab-large-values}"
: "${FRANK_LAB_RUN_ID:=$(date +%s)-$$}"
export COMPOSE_PROJECT_NAME FRANK_LAB_RUN_ID
# A private qualification job may select its reviewed S3 service overlay. This
# never chooses a production endpoint or changes the application's configuration.
compose() {
  if [ -n "${FRANK_LAB_COMPOSE_OVERRIDE:-}" ]; then
    test -f "$FRANK_LAB_COMPOSE_OVERRIDE"
    docker compose -f backend/labs/compose.large-values.yml -f "$FRANK_LAB_COMPOSE_OVERRIDE" "$@"
  else
    docker compose -f backend/labs/compose.large-values.yml "$@"
  fi
}
teardown() {
  if [ "${FRANK_LAB_KEEP:-0}" = 1 ]; then
    echo "kept Compose project $COMPOSE_PROJECT_NAME"
  else
    compose --profile init --profile test down --volumes --remove-orphans
  fi
}
trap teardown EXIT
phase() {
  service=$1
  test_name=$2
  executable=${3:-/large-value-contract}
  echo "=== $test_name on $service ($executable)"
  # libtest exits zero for an absent --exact filter. Check the actual current
  # executable's inventory first, including when selecting the private DM owner.
  listing=$(compose --profile test run --rm --no-deps --entrypoint "$executable" "$service" --list)
  printf '%s\n' "$listing" | grep -Fx -- "$test_name: test" >/dev/null || {
    echo "required test missing: $test_name" >&2
    exit 1
  }
  compose --profile test run --rm --no-deps --entrypoint "$executable" "$service" \
    --ignored --nocapture --test-threads=1 --exact "$test_name"
}
owner_phase() {
  phase "$1" "store::evm_direct_messages::large_request_tests::live_fdb_s3::$2" /large-value-owner-contract
}

# Complete compilation before starting the disposable runtime services.
compose --profile test build relay-a
compose up -d fdb minio
# A new disposable database: initialize the single-node lab once its cluster file exists.
attempt=0
until compose exec -T fdb test -s /cluster/fdb.cluster 2>/dev/null; do
  attempt=$((attempt + 1)); [ "$attempt" -lt 30 ] || { echo "fdb did not start"; exit 1; }; sleep 2
done
if ! compose exec -T fdb fdbcli -C /cluster/fdb.cluster --timeout 5 --exec 'status minimal' | grep -qF 'The database is available.'; then
  compose exec -T fdb fdbcli -C /cluster/fdb.cluster --timeout 20 --exec 'configure new single ssd'
fi
compose up -d --wait fdb minio
compose --profile init run --rm --no-deps minio-init
phase relay-a relay_a_appends_a_1_mib_message
phase relay-b relay_b_reads_the_1_mib_message_byte_exact
phase relay-a group_inline_boundary_round_trips_through_fdb_and_s3
phase relay-b namespace_claims_race_and_survive_reopen
phase relay-a stage_orphan_and_ambiguous_committed_reference
owner_phase relay-a append_largest_request
echo "=== stopping MinIO"
compose stop minio
phase relay-a with_minio_stopped_a_large_append_fails_closed
echo "=== restarting MinIO"
compose up -d --wait minio
phase relay-b after_minio_restarts_the_append_lands_as_the_next_sequence
phase relay-b namespace_claims_remain_exclusive_after_service_restart
phase relay-b reopened_intents_are_collected_without_losing_committed_bytes
owner_phase relay-b reopen_largest_request_and_retry_without_duplicate
phase relay-a an_orphan_is_swept_and_a_referenced_object_never_is
phase relay-b cleanup_removes_this_runs_subspace
echo "large-value acceptance passed (run $FRANK_LAB_RUN_ID)"
