#!/usr/bin/env bash
# shellcheck disable=SC2154 # health_*/ingest_* come from eval of load_stop output
# Automatic rollback test: deploy an image that crashes on boot, under load. deploy.sh must
# refuse to switch, exit non-zero, and the live version must keep serving without errors.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

live_before=$(live_version)
base_image=$(state_get "$(state_get ACTIVE_COLOR | tr '[:lower:]' '[:upper:]')_IMAGE")

# A "bad release": same app, but the process dies at startup.
docker build -q -t webhook-relay:broken - >/dev/null <<EOF
FROM $base_image
CMD ["node", "-e", "console.error(JSON.stringify({level:'error',event:'boot.crash',error:'simulated bad release'})); process.exit(1)"]
EOF
docker tag "${base_image/webhook-relay:/webhook-relay-migrate:}" webhook-relay-migrate:broken

dir=/tmp/load-rollback
load_start "$dir"
sleep 2
started=$SECONDS
if "$DEPLOY_DIR/scripts/deploy.sh" --image webhook-relay:broken; then
  load_stop "$dir" >/dev/null
  say "deploy of a crashing image succeeded: rollback logic is broken"
  exit 1
fi
rollback_s=$((SECONDS - started))
sleep 2
result=$(load_stop "$dir")
live_after=$(live_version)
eval "$result"
say "rollback: $result (live $live_before -> $live_after)"

{
  echo "### Automatic rollback (image that crashes on boot)"
  echo "| metric | value |"
  echo "|---|---|"
  echo "| deploy.sh exit | non-zero after ${rollback_s}s (new color never healthy, proxy not switched) |"
  echo "| live version before / after | $live_before / $live_after |"
  echo "| requests during the failed deploy | $((health_total + ingest_total)) |"
  echo "| ↳ errors / timeouts | **$((health_errors + ingest_errors))** |"
} | tee -a "$SUMMARY"

[ "$live_after" = "$live_before" ] || { say "live version changed"; exit 1; }
[ "$health_errors" = 0 ] && [ "$ingest_errors" = 0 ] || { say "requests failed during the failed deploy"; exit 1; }
[ -z "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=app_$(other_color "$(state_get ACTIVE_COLOR)")")" ] ||
  { say "the broken color is still running"; exit 1; }
say "rollback ok"
