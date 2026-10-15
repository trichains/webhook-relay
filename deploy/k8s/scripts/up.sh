#!/usr/bin/env bash
# Creates the kind cluster for the lab and installs its add-ons:
#   - ingress-nginx (kind provider manifest: hostPort 80/443 on the ingress-ready node)
#   - metrics-server (resource metrics for `kubectl top` and the HPA)
# Idempotent: an existing cluster is reused, manifests are re-applied.
#
#   deploy/k8s/scripts/up.sh
#   kind delete cluster --name webhook-relay-lab    # tear down
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need docker kind kubectl helm

if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  say "cluster $CLUSTER already exists"
else
  say "creating kind cluster $CLUSTER ($KIND_NODE_IMAGE)"
  kind create cluster --name "$CLUSTER" --config "$K8S_DIR/kind-config.yaml" --image "$KIND_NODE_IMAGE" --wait 120s
fi
k cluster-info >/dev/null
say "kubernetes $(k version -o json | jq -r .serverVersion.gitVersion), node $(k get nodes -o jsonpath='{.items[0].metadata.name}')"

say "installing ingress-nginx $INGRESS_NGINX_VERSION"
k apply -f "https://raw.githubusercontent.com/kubernetes/ingress-nginx/$INGRESS_NGINX_VERSION/deploy/static/provider/kind/deploy.yaml" >/dev/null
k -n ingress-nginx rollout status deploy/ingress-nginx-controller --timeout=180s

say "installing metrics-server $METRICS_SERVER_VERSION"
k apply -f "https://github.com/kubernetes-sigs/metrics-server/releases/download/$METRICS_SERVER_VERSION/components.yaml" >/dev/null
# kind's kubelets serve self-signed certificates: lab-only flag, never on a real cluster.
if ! k -n kube-system get deploy metrics-server -o jsonpath='{.spec.template.spec.containers[0].args}' | grep -q kubelet-insecure-tls; then
  k -n kube-system patch deploy metrics-server --type=json \
    -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' >/dev/null
fi
k -n kube-system rollout status deploy/metrics-server --timeout=180s

# The ingress admission webhook can refuse Ingress objects for a few seconds after the controller
# reports ready; a server-side dry run proves it answers before the first `helm install`.
probe_ingress() {
  k apply --dry-run=server -f - >/dev/null 2>&1 <<'EOF'
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: admission-probe
  namespace: default
spec:
  ingressClassName: nginx
  rules:
    - http:
        paths:
          - path: /probe
            pathType: Prefix
            backend:
              service:
                name: none
                port:
                  number: 80
EOF
}
wait_until 90 probe_ingress || die "ingress-nginx admission webhook not answering"

metrics_ready() { k top nodes >/dev/null 2>&1; }
say "waiting for the metrics API"
wait_until 180 metrics_ready || die "metrics-server is not serving metrics"
k top nodes >&2
say "cluster ready: ingress on http://localhost, metrics API available"
