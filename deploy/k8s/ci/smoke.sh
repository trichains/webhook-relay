#!/usr/bin/env bash
# Smoke test of the Helm release from outside the cluster (through the ingress): health, auth,
# signed webhook -> delivered to the built-in sink, and the scheduler CronJob draining a queued
# delivery. Also records what the release created.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

fail() {
  say "SMOKE FAILED: $*"
  exit 1
}

health=$(curl -s -m 5 "$BASE_URL/api/health")
[ "$(jq -r .ok <<<"$health")" = "true" ] || fail "health: $health"
[ "$(jq -r .driver <<<"$health")" = "pg" ] || fail "expected the Postgres driver, got: $health"

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/dashboard")
[ "$code" = "401" ] || fail "dashboard without credentials should be 401 (got $code)"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/v1/events")
[ "$code" = "401" ] || fail "management API without token should be 401 (got $code)"

ensure_ci_source

started=$(date +%s%N)
code=$(send_webhook "smoke-$(date +%s)" /tmp/k8s-smoke-ingest.json)
[ "$code" = "202" ] || fail "ingest returned $code: $(cat /tmp/k8s-smoke-ingest.json)"
event_id=$(jq -r .eventId /tmp/k8s-smoke-ingest.json)
delivered() { [ "$(api "/api/v1/events/$event_id" | jq -r .status)" = "delivered" ]; }
wait_until 30 delivered || fail "event $event_id not delivered: $(api "/api/v1/events/$event_id")"
latency=$(awk -v a="$started" -v b="$(date +%s%N)" 'BEGIN {printf "%.2f", (b - a) / 1e9}')
attempt=$(api "/api/v1/events/$event_id" | jq -c '.deliveries[0] | {destination: .destination.url, status, code: .attempts[0].statusCode}')
say "event $event_id delivered in ${latency}s: $attempt"

bad_code=$(CI_SECRET=wrong send_webhook "smoke-bad-sig")
[ "$bad_code" = "401" ] || fail "wrong signature should be 401 (got $bad_code)"

# Scheduler: queue a delivery directly in the database, then run the CronJob once on demand
# (kubectl create job --from) instead of waiting for the next minute. The schedule is suspended
# meanwhile, so the on-demand run is the one that sends it.
kn patch cronjob "$RELEASE-scheduler" --type=merge -p '{"spec":{"suspend":true}}' >/dev/null
trap 'kn patch cronjob "$RELEASE-scheduler" --type=merge -p "{\"spec\":{\"suspend\":false}}" >/dev/null || true' EXIT
psql_q -q -c "
  insert into destinations (id, source_id, name, url, max_attempts, timeout_ms)
  values ('dst_ci_sched', 'src_ci', 'Scheduler check', '/api/sink/ok', 6, 10000) on conflict (id) do nothing;
  insert into deliveries (id, event_id, destination_id, status, next_attempt_at)
  values ('dlv_ci_sched', '$event_id', 'dst_ci_sched', 'pending', now()) on conflict (id) do nothing;" >/dev/null
kn delete job scheduler-smoke --ignore-not-found >/dev/null
kn create job scheduler-smoke --from="cronjob/$RELEASE-scheduler" >/dev/null
kn wait --for=condition=complete job/scheduler-smoke --timeout=90s >/dev/null ||
  fail "scheduler job did not complete: $(kn logs job/scheduler-smoke 2>&1 | tail -n 5)"
tick=$(kn logs job/scheduler-smoke | tail -n 1)
say "scheduler tick: $tick"
sched_status=$(psql_q -At -c "select status from deliveries where id = 'dlv_ci_sched'")
claimed=$(jq -r '.body | fromjson | .claimed // 0' <<<"$tick" 2>/dev/null || echo 0)
[ "$(jq -r .status <<<"$tick")" = 200 ] && [ "$claimed" -ge 1 ] ||
  fail "the on-demand scheduler run did not claim the queued delivery: $tick"
[ "$sched_status" = "succeeded" ] || fail "queued delivery not sent by the scheduler (status $sched_status)"

migrate_log=$(kn logs "job/$RELEASE-migrate" 2>/dev/null | tail -n 1)
pods=$(web_pods --no-headers | awk '{print $1 " (" $2 ", " $3 ")"}' | paste -sd ',' - | sed 's/,/, /g')
pdb=$(kn get pdb "$RELEASE" -o jsonpath='{.spec.minAvailable} min available, {.status.disruptionsAllowed} disruption(s) allowed')
hpa=$(kn get hpa "$RELEASE" -o jsonpath='{.spec.minReplicas}-{.spec.maxReplicas} replicas, CPU target {.spec.metrics[0].resource.target.averageUtilization}%')
user=$(kn get deploy "$RELEASE" -o jsonpath='{.spec.template.spec.securityContext.runAsUser}')
rofs=$(kn get deploy "$RELEASE" -o jsonpath='{.spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem}')
k8s=$(k version -o json | jq -r .serverVersion.gitVersion)

{
  echo "## Kubernetes lab (kind, Kubernetes $k8s)"
  echo "### Smoke test (through the ingress)"
  echo "| check | result |"
  echo "|---|---|"
  echo "| health | ok, driver=pg, version=$(jq -r .version <<<"$health") |"
  echo "| dashboard / API without credentials | 401 / 401 |"
  echo "| signed webhook → delivered to /api/sink/ok | ${latency}s ($attempt) |"
  echo "| wrong signature | 401 |"
  echo "| scheduler CronJob run on demand → queued delivery sent | $sched_status |"
  echo "| migration hook Job (last log line) | \`$migrate_log\` |"
  echo "| web pods | $pods |"
  echo "| HPA | $hpa |"
  echo "| PodDisruptionBudget | $pdb |"
  echo "| pod security | runAsUser $user, readOnlyRootFilesystem=$rofs, no service account token |"
} | report
say "smoke ok"
