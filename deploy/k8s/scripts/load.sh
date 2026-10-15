#!/usr/bin/env bash
# CPU load for the HPA: a pod inside the cluster (same image as the app, nothing pulled) sends
# concurrent GET /api/health requests through the ingress controller, so the ingress spreads them
# over every Ready pod, including the ones the HPA adds. Blocks until the run ends and prints a
# JSON summary on stdout.
#
#   deploy/k8s/scripts/load.sh [seconds=120] [concurrency=48]
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need kubectl jq

DURATION=${1:-120}
CONCURRENCY=${2:-48}
URL=${LOAD_URL:-http://ingress-nginx-controller.ingress-nginx.svc.cluster.local/api/health}
IMAGE=$(kn get deploy "$RELEASE" -o jsonpath='{.spec.template.spec.containers[0].image}')
POD=relay-load

kn delete pod "$POD" --ignore-not-found --wait=true >/dev/null
say "load: $CONCURRENCY workers for ${DURATION}s -> $URL"
kn apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $POD
  labels:
    app.kubernetes.io/name: relay-load
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    seccompProfile: { type: RuntimeDefault }
  containers:
    - name: load
      image: $IMAGE
      imagePullPolicy: IfNotPresent
      env:
        - { name: URL, value: "$URL" }
        - { name: DURATION, value: "$DURATION" }
        - { name: CONCURRENCY, value: "$CONCURRENCY" }
      resources:
        requests: { cpu: 100m, memory: 64Mi }
        limits: { cpu: "1", memory: 256Mi }
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: { drop: [ALL] }
      command:
        - node
        - -e
        - |
          const http = require("node:http");
          // No keep-alive: every request opens a new connection, as many separate clients would.
          const agent = new http.Agent({ keepAlive: false });
          const end = Date.now() + Number(process.env.DURATION) * 1000;
          const stats = { requests: 0, ok: 0, errors: 0, codes: {} };
          const once = () => new Promise((resolve) => {
            const req = http.get(process.env.URL, { agent, timeout: 10000 }, (res) => {
              res.resume();
              res.on("end", () => {
                stats.codes[res.statusCode] = (stats.codes[res.statusCode] || 0) + 1;
                res.statusCode === 200 ? stats.ok++ : stats.errors++;
                resolve();
              });
            });
            req.on("timeout", () => req.destroy(new Error("timeout")));
            req.on("error", (e) => { stats.codes[e.message] = (stats.codes[e.message] || 0) + 1; stats.errors++; resolve(); });
          });
          const worker = async () => { while (Date.now() < end) { stats.requests++; await once(); } };
          Promise.all(Array.from({ length: Number(process.env.CONCURRENCY) }, worker)).then(() => {
            console.log(JSON.stringify(stats));
          });
EOF

phase() { kn get pod "$POD" -o jsonpath='{.status.phase}' 2>/dev/null; }
done_running() { case "$(phase)" in Succeeded | Failed) return 0 ;; *) return 1 ;; esac; }
wait_until $((DURATION + 120)) done_running || die "load pod did not finish"
[ "$(phase)" = "Succeeded" ] || die "load pod failed: $(kn logs "$POD" 2>&1 | tail -n 5)"
kn logs "$POD" | tail -n 1
kn delete pod "$POD" --wait=false >/dev/null
