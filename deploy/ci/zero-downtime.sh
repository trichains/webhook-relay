#!/usr/bin/env bash
# shellcheck disable=SC2154 # health_*/ingest_* come from eval of load_stop output
# Zero-downtime test: continuous HTTPS traffic (health + signed ingest) while deploy.sh moves the
# stack to a new version. Any non-2xx response or timeout fails the job.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

NEW_TAG=${1:-v2}
before=$(live_version)
dir=/tmp/load-deploy
load_start "$dir"
sleep 3
deploy_started=$SECONDS
"$DEPLOY_DIR/scripts/deploy.sh" --build "$NEW_TAG"
deploy_s=$((SECONDS - deploy_started))
sleep 3
result=$(load_stop "$dir")
after=$(live_version)
say "zero-downtime: $result"
eval "$result"

{
  echo "### Zero-downtime deploy ($before → $after)"
  echo "| metric | value |"
  echo "|---|---|"
  echo "| deploy.sh duration (build + migrate + start + switch + drain) | ${deploy_s}s |"
  echo "| /api/health requests during deploy | $health_total |"
  echo "| ↳ errors / timeouts | **$health_errors** |"
  echo "| ↳ slowest response | ${health_max_s}s |"
  echo "| signed webhooks ingested during deploy | $ingest_total |"
  echo "| ↳ errors / timeouts | **$ingest_errors** |"
} | tee -a "$SUMMARY"

[ "$after" = "$NEW_TAG" ] || { say "expected version $NEW_TAG after deploy, got $after"; exit 1; }
[ "$health_total" -gt 50 ] || { say "too few requests ($health_total): the load generator did not run"; exit 1; }
[ "$health_errors" = 0 ] && [ "$ingest_errors" = 0 ] || { say "requests failed during the deploy"; exit 1; }
say "zero-downtime ok"
