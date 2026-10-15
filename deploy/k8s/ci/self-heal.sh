#!/usr/bin/env bash
# shellcheck disable=SC2154 # health_*/ingest_* come from eval of load_stop output
# Self-healing and disruption budget, under traffic through the ingress:
#   1. delete a web pod: the ReplicaSet creates a replacement, the deleted pod drains gracefully;
#   2. evict pods the way `kubectl drain` does (Eviction API): the PodDisruptionBudget allows only
#      as many evictions as it has room for and refuses the next one.
# No request may fail.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

desired=$(kn get deploy "$RELEASE" -o jsonpath='{.spec.replicas}')
before=$(ready_web_pods | sort)
victim=$(head -n 1 <<<"$before")
dir=/tmp/k8s-selfheal
load_start "$dir"
sleep 3

# 1) Delete a pod (graceful: preStop + SIGTERM, like any pod replacement).
say "deleting pod $victim"
t0=$(date +%s%N)
kn delete pod "$victim" --wait=false >/dev/null
replacement_ready() {
  local p
  for p in $(ready_web_pods); do
    grep -qx "$p" <<<"$before" || {
      echo "$p" >/tmp/k8s-selfheal-replacement
      return 0
    }
  done
  return 1
}
wait_until 120 replacement_ready || { say "no replacement pod became Ready"; exit 1; }
heal_s=$(awk -v a="$t0" -v b="$(date +%s%N)" 'BEGIN {printf "%.1f", (b - a) / 1e9}')
replacement=$(cat /tmp/k8s-selfheal-replacement)
say "replacement $replacement Ready after ${heal_s}s"
victim_gone() { ! kn get pod "$victim" >/dev/null 2>&1; }
wait_until 90 victim_gone || { say "$victim did not terminate"; exit 1; }
full_strength() { [ "$(ready_web_pods | grep -c .)" -ge "$desired" ]; }
wait_until 60 full_strength || { say "deployment did not return to $desired ready pods"; exit 1; }

# 2) Evictions against the PodDisruptionBudget.
sleep 5 # let the disruption controller recount healthy pods
allowed=$(kn get pdb "$RELEASE" -o jsonpath='{.status.disruptionsAllowed}')
evicted=0
refused=""
for pod in $(ready_web_pods); do
  out=$(k create --raw "/api/v1/namespaces/$NAMESPACE/pods/$pod/eviction" -f - 2>&1 <<EOF
{"apiVersion": "policy/v1", "kind": "Eviction", "metadata": {"name": "$pod", "namespace": "$NAMESPACE"}}
EOF
  ) && {
    evicted=$((evicted + 1))
    say "evicted $pod"
    continue
  }
  refused=$(grep -o 'violate the pod.s disruption budget' <<<"$out" || echo "$out")
  say "eviction of $pod refused: $refused"
  break
done
wait_until 120 full_strength || { say "deployment did not recover after the evictions"; exit 1; }
sleep 3
result=$(load_stop "$dir")
eval "$result"
say "self-heal: $result"

{
  echo "### Self-healing and PodDisruptionBudget (under traffic)"
  echo "| metric | value |"
  echo "|---|---|"
  echo "| pod deleted → replacement Ready | $victim → $replacement in **${heal_s}s** |"
  echo "| evictions (Eviction API, as in a node drain) | $evicted allowed (PDB said $allowed), next one refused: ${refused:-none} |"
  echo "| requests during deletion + evictions | $((health_total + ingest_total)) |"
  echo "| ↳ errors / timeouts | **$((health_errors + ingest_errors))** |"
} | report

[ "$evicted" = "$allowed" ] && [ -n "$refused" ] || { say "the PDB did not limit evictions as expected"; exit 1; }
[ "$health_errors" = 0 ] && [ "$ingest_errors" = 0 ] || { say "requests failed during the disruption"; exit 1; }
say "self-heal ok"
