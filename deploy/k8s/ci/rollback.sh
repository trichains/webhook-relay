#!/usr/bin/env bash
# shellcheck disable=SC2154 # health_*/ingest_* come from eval of load_stop output
# Automatic rollback: upgrade to an image that crashes on boot, under traffic. The new pod never
# becomes Ready, maxUnavailable 0 keeps the old pods serving, `helm upgrade --atomic` times out
# and rolls the release back by itself. No request may fail.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

live_before=$(live_version)
base_tag=$(deployed_tag)
rev_before=$(h status "$RELEASE" -n "$NAMESPACE" -o json | jq -r .version)

# A "bad release": same app, but the process dies at startup. The migration image is unchanged.
docker build -q -t webhook-relay:broken - >/dev/null <<EOF
FROM webhook-relay:$base_tag
CMD ["node", "-e", "console.error(JSON.stringify({level:'error',event:'boot.crash',error:'simulated bad release'})); process.exit(1)"]
EOF
docker tag "webhook-relay-migrate:$base_tag" webhook-relay-migrate:broken

dir=/tmp/k8s-rollback-$(date +%s)
load_start "$dir"
sleep 2
started=$SECONDS
if HELM_TIMEOUT=${ROLLBACK_TIMEOUT:-75s} "$K8S_DIR/scripts/deploy.sh" broken; then
  load_stop "$dir" >/dev/null
  say "the upgrade to a crashing image succeeded: rollback protection is broken"
  exit 1
fi
rollback_s=$((SECONDS - started))
say "helm upgrade failed after ${rollback_s}s, as expected"

no_broken_pods() { ! web_pods -o jsonpath='{.items[*].spec.containers[0].image}' | grep -q ':broken'; }
wait_until 90 no_broken_pods || { say "a broken pod is still around"; exit 1; }
sleep 2
result=$(load_stop "$dir")
eval "$result"
live_after=$(live_version)
tag_after=$(deployed_tag)
rev_after=$(h status "$RELEASE" -n "$NAMESPACE" -o json | jq -r .version)
history=$(h history "$RELEASE" -n "$NAMESPACE" -o json | jq -r '.[-3:][] | "\(.revision): \(.status) (\(.description))"' | paste -sd ';' - | sed 's/;/; /g')
restarts=$(kn get events --field-selector reason=BackOff -o json | jq '[.items[] | select(.involvedObject.name | startswith("'"$RELEASE"'-"))] | length')
say "rollback: $result (live $live_before -> $live_after); history: $history"

{
  echo "### Automatic rollback (image that crashes on boot, helm --atomic)"
  echo "| metric | value |"
  echo "|---|---|"
  echo "| helm upgrade exit | non-zero after ${rollback_s}s (timeout ${ROLLBACK_TIMEOUT:-75s}, then automatic rollback) |"
  echo "| helm history (last 3) | $history |"
  echo "| live version before / after | $live_before / $live_after (image tag $tag_after) |"
  echo "| CrashLoop back-off events for the broken pod | $restarts |"
  echo "| requests during the failed upgrade | $((health_total + ingest_total)) |"
  echo "| ↳ errors / timeouts | **$((health_errors + ingest_errors))** |"
} | report

[ "$live_after" = "$live_before" ] || { say "live version changed"; exit 1; }
[ "$tag_after" = "$base_tag" ] || { say "deployment image is $tag_after, expected $base_tag"; exit 1; }
last=$(h history "$RELEASE" -n "$NAMESPACE" -o json | jq -r '.[-1] | "\(.status)|\(.description)"')
[ "$last" = "deployed|Rollback to $rev_before" ] || { say "expected the last revision to be 'Rollback to $rev_before', got: $last"; exit 1; }
[ "$rev_after" -gt "$rev_before" ] || { say "no rollback revision recorded"; exit 1; }
[ "$restarts" -gt 0 ] || { say "the broken pod never crash-looped: the failure was something else"; exit 1; }
[ "$health_errors" = 0 ] && [ "$ingest_errors" = 0 ] || { say "requests failed during the failed upgrade"; exit 1; }
say "rollback ok"
