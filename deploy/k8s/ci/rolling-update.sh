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
# Follow the old pods' logs: they disappear with the pods, and they explain any delivery problem.
for p in $old_pods; do kn logs -f "$p" >"$dir/pod-$p.log" 2>&1 & done
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

wait_started=$SECONDS
read -r delivered pending other <<<"$(wait_deliveries "$dir")"
settle_s=$((SECONDS - wait_started))
retried=$(load_retried "$dir")
replicas_after=$(kn get deploy "$RELEASE" -o jsonpath='{.status.readyReplicas}')
say "webhooks accepted during the rollout: $ingest_ok, delivered $delivered (after ${settle_s}s), pending $pending, other $other, needed a retry $retried"
if [ "$pending" != 0 ] || [ "$other" != 0 ] || [ "$retried" != 0 ]; then
  say "webhooks that were not delivered on the first attempt (delivery state and attempts):"
  psql_q -c "
    select e.id, e.payload->>'id' as webhook, e.received_at, d.status, d.attempt_count, d.locked_at,
           d.next_attempt_at, d.last_status_code, left(d.last_error, 120) as last_error
    from events e join deliveries d on d.event_id = e.id
    where e.source_id = 'src_ci' and e.payload->>'id' like 'load-$(basename "$dir")-%' and (e.status <> 'delivered' or d.attempt_count > 1)
    order by e.received_at" >&2
  psql_q -c "
    select a.delivery_id, a.attempt_number, a.trigger, a.ok, a.status_code, a.latency_ms, a.started_at, left(a.error, 120) as error
    from attempts a join deliveries d on d.id = a.delivery_id join events e on e.id = d.event_id
    where e.source_id = 'src_ci' and e.payload->>'id' like 'load-$(basename "$dir")-%' and (e.status <> 'delivered' or d.attempt_count > 1)
    order by a.started_at" >&2
  for id in $(psql_q -At -c "select e.id from events e join deliveries d on d.event_id = e.id where e.source_id = 'src_ci' and e.payload->>'id' like 'load-$(basename "$dir")-%' and (e.status <> 'delivered' or d.attempt_count > 1)"); do
    grep -h "$id" "$dir"/pod-*.log >&2 || true
  done
  say "old pods' last log lines:"
  tail -n 15 "$dir"/pod-*.log >&2 || true
fi

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
  echo "| ↳ delivered / still pending / other (checked for up to 390s) | $delivered / $pending / $other, all settled ${settle_s}s after the rollout |"
  echo "| ↳ needed more than the first attempt | $retried |"
  echo "| ready pods after the rollout (the HPA may have added some) | $replicas_after |"
} | report

[ "$after" = "$NEW_TAG" ] || { say "expected version $NEW_TAG after the upgrade, got $after"; exit 1; }
[ "$health_total" -gt 50 ] || { say "too few requests ($health_total): the load generator did not run"; exit 1; }
[ "$health_errors" = 0 ] && [ "$ingest_errors" = 0 ] || { say "requests failed during the rollout"; exit 1; }
[ "$pending" = 0 ] && [ "$other" = 0 ] && [ "$delivered" = "$ingest_ok" ] ||
  { say "not every accepted webhook was delivered"; exit 1; }
say "rolling update ok"
