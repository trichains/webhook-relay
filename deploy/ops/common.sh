#!/usr/bin/env bash
# Shared helpers for the ops containers. Logs are one JSON object per line (same shape as the app).
log() {
  local level=$1 event=$2 detail=${3:-}
  jq -cn --arg level "$level" --arg event "$event" --arg detail "$detail" --arg svc "${OPS_SERVICE:-ops}" \
    '{ts:(now|floor|todate),level:$level,service:$svc,event:$event} + (if $detail == "" then {} else {detail:$detail} end)'
}
