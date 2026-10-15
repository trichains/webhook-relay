#!/usr/bin/env bash
# shellcheck disable=SC2154 # health_*/ingest_* come from eval of load_stop output
# Rolling update without downtime: continuous traffic through the ingress (health + signed
# webhooks) while `helm upgrade --wait --atomic` moves the Deployment to a new image. Any non-2xx
# response or timeout fails the job, and every webhook accepted during the rollout must end up
# delivered (pods drain their after() work on SIGTERM).
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

NEW_TAG=${1:-v2}
before=$(live_version)
old_pods=$(ready_web_pods | sort)
rev_before=$(h status "$RELEASE" -n "$NAMESPACE" -o json | jq -r .version)
dir=/tmp/k8s-rolling
load_start "$dir"
sleep 3
started=$SECONDS
"$K8S_DIR/scripts/deploy.sh" --build "$NEW_TAG"
deploy_s=$((SECONDS - started))
sleep 3
result=$(load_stop "$dir")
eval "$result"
after=$(live_version)
new_pods=$(ready_web_pods | sort)
replaced=$(comm -23 <(echo "$old_pods") <(echo "$new_pods") | grep -c . || true)
rev_after=$(h status "$RELEASE" -n "$NAMESPACE" -o json | jq -r .version)
say "rolling update $before -> $after: $result"

read -r delivered pending other <<<"$(wait_deliveries "$dir")"
say "webhooks accepted during the rollout: $ingest_ok, delivered $delivered, pending $pending, other $other"

{
  echo "### Rolling update without downtime ($before → $after, helm revision $rev_before → $rev_after)"
  echo "| metric | value |"
  echo "|---|---|"
  echo "| deploy.sh (build + kind load + migration hook + rollout, --wait --atomic) | ${deploy_s}s |"
  echo "| strategy | RollingUpdate maxSurge 1 / maxUnavailable 0, preStop 10s, grace 40s |"
  echo "| pods replaced | $replaced of $(echo "$old_pods" | grep -c .) |"
  echo "| /api/health requests through the ingress during the rollout | $health_total |"
  echo "| ↳ errors / timeouts | **$health_errors** (slowest ${health_max_s}s) |"
  echo "| signed webhooks during the rollout | $ingest_total |"
  echo "| ↳ errors / timeouts | **$ingest_errors** |"
  echo "| ↳ delivered afterwards / still pending / other | $delivered / $pending / $other |"
} | report

[ "$after" = "$NEW_TAG" ] || { say "expected version $NEW_TAG after the upgrade, got $after"; exit 1; }
[ "$health_total" -gt 50 ] || { say "too few requests ($health_total): the load generator did not run"; exit 1; }
[ "$health_errors" = 0 ] && [ "$ingest_errors" = 0 ] || { say "requests failed during the rollout"; exit 1; }
[ "$pending" = 0 ] && [ "$other" = 0 ] && [ "$delivered" = "$ingest_ok" ] ||
  { say "not every accepted webhook was delivered"; exit 1; }
say "rolling update ok"
