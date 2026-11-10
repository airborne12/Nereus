#!/usr/bin/env bash
set -euo pipefail

with_jaeger=0
case "${1:-}" in
  '') ;;
  --jaeger) with_jaeger=1 ;;
  -h|--help)
    echo 'Usage: tests/ingestion/run.sh [--jaeger]'
    echo 'Requires Docker Compose. Set INGEST_TEST_OUTPUT to choose the artifact directory.'
    exit 0 ;;
  *) echo 'Usage: tests/ingestion/run.sh [--jaeger]' >&2; exit 2 ;;
esac
if (( $# > 1 )); then echo 'Unexpected arguments' >&2; exit 2; fi

suite_dir=$(cd "$(dirname "$0")" && pwd)
repo_dir=$(cd "$suite_dir/../.." && pwd)
docker compose version >/dev/null
export INGEST_TEST_PROJECT="nereus-ingest-$(date -u +%Y%m%d%H%M%S)-$$-${RANDOM}"
export INGEST_TEST_UID=$(id -u) INGEST_TEST_GID=$(id -g) INGEST_TEST_JAEGER=$with_jaeger
output_root=${INGEST_TEST_OUTPUT:-"$repo_dir/test-results/ingestion"}
mkdir -p -- "$output_root"
output_root=$(cd "$output_root" && pwd)
export INGEST_TEST_ARTIFACTS=$(mktemp -d "$output_root/${INGEST_TEST_PROJECT}.XXXXXX")
compose=(docker compose --project-name "$INGEST_TEST_PROJECT" --file "$suite_dir/compose.yaml" --profile test)
if (( with_jaeger )); then compose+=(--profile jaeger); fi
{
  printf '#!/usr/bin/env bash\nset -euo pipefail\n'
  for name in INGEST_TEST_PROJECT INGEST_TEST_ARTIFACTS INGEST_TEST_UID INGEST_TEST_GID INGEST_TEST_JAEGER; do
    printf 'export %s=%q\n' "$name" "${!name}"
  done
  printf 'docker compose --project-name %q --file %q --profile test --profile jaeger down --volumes --remove-orphans\n' "$INGEST_TEST_PROJECT" "$suite_dir/compose.yaml"
} > "$INGEST_TEST_ARTIFACTS/cleanup-command.sh"
chmod 700 "$INGEST_TEST_ARTIFACTS/cleanup-command.sh"

cleanup() {
  local result=$?
  trap - EXIT
  "${compose[@]}" logs --no-color > "$INGEST_TEST_ARTIFACTS/compose.log" 2>&1 || true
  if ! "${compose[@]}" down --volumes --remove-orphans > "$INGEST_TEST_ARTIFACTS/cleanup.log" 2>&1; then
    echo "Test environment cleanup failed; see $INGEST_TEST_ARTIFACTS/cleanup.log" >&2
    result=1
  fi
  local remaining_containers remaining_networks
  remaining_containers=$(docker ps -aq --filter "label=com.docker.compose.project=$INGEST_TEST_PROJECT")
  remaining_networks=$(docker network ls -q --filter "label=com.docker.compose.project=$INGEST_TEST_PROJECT")
  if [[ -n "$remaining_containers" || -n "$remaining_networks" ]]; then
    echo 'The test project still has containers or networks; run cleanup-command.sh from its artifact directory.' >&2
    result=1
  fi
  echo "Test artifacts: $INGEST_TEST_ARTIFACTS"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Starting isolated test project: $INGEST_TEST_PROJECT"
build_services=(nereus client)
stack_services=(nereus collector)
if (( with_jaeger )); then
  build_services+=(jaeger-client)
  stack_services+=(jaeger-collector)
fi
"${compose[@]}" build "${build_services[@]}"
"${compose[@]}" up --detach --wait --wait-timeout 300 "${stack_services[@]}"
for transport in http grpc; do
  endpoint=http://collector:4318
  if [[ "$transport" == grpc ]]; then endpoint=collector:4317; fi
  "${compose[@]}" run --rm --no-deps -T client python sdk_client.py \
    --transport "$transport" --endpoint "$endpoint" --requests 20 \
    --run-id "${INGEST_TEST_PROJECT}-${transport}" --out "/artifacts/${transport}.json"
  "${compose[@]}" run --rm --no-deps -T client python fidelity_client.py \
    --transport "$transport" --endpoint "$endpoint" \
    --run-id "${INGEST_TEST_PROJECT}-fidelity-${transport}" --out "/artifacts/fidelity-${transport}.json"
done
if (( with_jaeger )); then
  "${compose[@]}" run --rm --no-deps -T jaeger-client python jaeger_client_send.py \
    --agent-host jaeger-collector --agent-port 6831 --requests 20 \
    --run-id "${INGEST_TEST_PROJECT}-jaeger" --out /artifacts/jaeger.json
fi
"${compose[@]}" run --rm --no-deps -T verify | tee "$INGEST_TEST_ARTIFACTS/results.tap"
