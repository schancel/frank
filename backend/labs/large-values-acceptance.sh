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
compose() { docker compose -f backend/labs/compose.large-values.yml "$@"; }
teardown() {
  if [ "${FRANK_LAB_KEEP:-0}" = 1 ]; then
    echo "kept Compose project $COMPOSE_PROJECT_NAME"
  else
    compose --profile init --profile test down --volumes --remove-orphans
  fi
}
trap teardown EXIT
phase() {
  echo "=== $2 on $1"
  compose --profile test run --rm --no-deps "$1" "$2"
}

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
compose --profile test build relay-a

phase relay-a relay_a_appends_a_1_mib_message
phase relay-b relay_b_reads_the_1_mib_message_byte_exact
echo "=== stopping MinIO"
compose stop minio
phase relay-a with_minio_stopped_a_large_append_fails_closed
echo "=== restarting MinIO"
compose up -d --wait minio
phase relay-b after_minio_restarts_the_append_lands_as_the_next_sequence
phase relay-a an_orphan_is_swept_and_a_referenced_object_never_is
phase relay-b cleanup_removes_this_runs_subspace
echo "large-value acceptance passed (run $FRANK_LAB_RUN_ID)"
