#!/usr/bin/env bash
# Horizontal Pod Autoscaler: generate CPU load inside the cluster (scripts/load.sh, through the
# ingress controller) and check that the HPA adds pods above minReplicas. Samples the HPA every
# 5 s into the log and reports the peak.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

DURATION=${HPA_LOAD_SECONDS:-150}
CONCURRENCY=${HPA_LOAD_CONCURRENCY:-32}
min=$(kn get hpa "$RELEASE" -o jsonpath='{.spec.minReplicas}')
max=$(kn get hpa "$RELEASE" -o jsonpath='{.spec.maxReplicas}')
target=$(kn get hpa "$RELEASE" -o jsonpath='{.spec.metrics[0].resource.target.averageUtilization}')

pod_metrics() { kn top pods -l "app.kubernetes.io/component=web" >/dev/null 2>&1; }
wait_until 120 pod_metrics || { say "no pod metrics from metrics-server"; exit 1; }
hpa_cpu() { kn get hpa "$RELEASE" -o jsonpath='{.status.currentMetrics[0].resource.current.averageUtilization}'; }
hpa_cpu_known() { [ -n "$(hpa_cpu)" ]; }
wait_until 120 hpa_cpu_known || { say "the HPA has no CPU reading yet"; exit 1; }
start_replicas=$(kn get hpa "$RELEASE" -o jsonpath='{.status.currentReplicas}')
say "hpa before load: replicas=$start_replicas cpu=$(hpa_cpu)% (target ${target}%, min $min, max $max)"

"$K8S_DIR/scripts/load.sh" "$DURATION" "$CONCURRENCY" >/tmp/k8s-hpa-load.json &
load_pid=$!
t0=$SECONDS
peak=$start_replicas
peak_cpu=0
first_up=""
samples=""
while kill -0 "$load_pid" 2>/dev/null; do
  sleep 5
  cur=$(kn get hpa "$RELEASE" -o jsonpath='{.status.currentReplicas}')
  want=$(kn get hpa "$RELEASE" -o jsonpath='{.status.desiredReplicas}')
  cpu=$(hpa_cpu)
  ready=$(ready_web_pods | grep -c . || true)
  say "hpa t+$((SECONDS - t0))s: cpu=${cpu:-?}% replicas=$cur desired=$want ready=$ready"
  samples+="$((SECONDS - t0))s:${cpu:-?}%/${cur} "
  if [ "${cur:-0}" -gt "$peak" ]; then peak=$cur; fi
  if [ "${cpu:-0}" -gt "$peak_cpu" ]; then peak_cpu=$cpu; fi
  if [ -z "$first_up" ] && [ "${cur:-0}" -gt "$min" ]; then first_up=$((SECONDS - t0)); fi
done
wait "$load_pid" || { say "load generator failed"; exit 1; }
load=$(tail -n 1 /tmp/k8s-hpa-load.json)
say "load result: $load"
events=$(kn get events --field-selector "involvedObject.kind=HorizontalPodAutoscaler,reason=SuccessfulRescale" \
  -o json | jq -r '[.items[].message] | unique | join("; ")')

{
  echo "### Horizontal Pod Autoscaler (CPU target ${target}%, min $min, max $max)"
  echo "| metric | value |"
  echo "|---|---|"
  echo "| load | ${DURATION}s, $CONCURRENCY concurrent clients in the cluster → ingress → /api/health |"
  echo "| replicas before load | $start_replicas |"
  echo "| first scale-up above min | ${first_up:-never}s after the load started |"
  echo "| peak replicas | **$peak** (peak average CPU ${peak_cpu}% of requests) |"
  echo "| HPA events | ${events:-none} |"
  echo "| load generator result | \`$load\` |"
  echo "| samples (time: cpu/replicas) | $samples |"
} | report

[ "$peak" -gt "$min" ] || { say "the HPA never scaled above minReplicas ($min)"; exit 1; }
say "hpa ok: scaled from $start_replicas to $peak replicas"
