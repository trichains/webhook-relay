# Kubernetes lab

[Português](kubernetes-lab.pt-BR.md) · [Self-hosting (Docker)](self-hosting.md)

This is a **study lab**: webhook-relay packaged as a Helm chart and exercised on a throwaway
[kind](https://kind.sigs.k8s.io/) cluster (Kubernetes in Docker) on every pull request, in
[`.github/workflows/k8s-lab.yml`](../.github/workflows/k8s-lab.yml). The goal is to learn and
prove, with numbers, how Kubernetes keeps the relay up while it is updated, rolled back, broken
and loaded. It is not a production setup and has never served real traffic: the
[limitations](#limitations) section lists what a real cluster would still need.

For running the relay on your own server today, use the [Docker kit](self-hosting.md).

## What runs

```
                http://localhost (port 80 of the kind node)
 webhook senders ──▶ ingress-nginx ──▶ Service relay ──▶ Pod relay-…  ┐  Deployment relay
   and the CI         (Ingress relay)                 ──▶ Pod relay-…  ┤  (2 to 5 pods, HPA)
                                                                      │
 CronJob relay-scheduler (every minute) ──▶ Service relay /api/cron/deliver
 Job relay-migrate (Helm hook, before every install/upgrade)          │
                                                                      ▼
                                   Service relay-postgres ──▶ StatefulSet relay-postgres + PVC
```

| file | what it is |
|---|---|
| [`deploy/k8s/chart/webhook-relay`](../deploy/k8s/chart/webhook-relay) | the app chart: Deployment, Service, Ingress, HPA, PodDisruptionBudget, migration Job, scheduler CronJob, ConfigMap, Secret, ServiceAccount |
| [`deploy/k8s/chart/postgres-lab`](../deploy/k8s/chart/postgres-lab) | one Postgres 17 pod with a persistent volume, in its own Helm release. Lab only |
| [`deploy/k8s/kind-config.yaml`](../deploy/k8s/kind-config.yaml) | one-node cluster, host ports 80/443 mapped to the ingress controller |
| [`deploy/k8s/scripts/up.sh`](../deploy/k8s/scripts/up.sh) | creates the cluster and installs ingress-nginx and metrics-server (pinned versions) |
| [`deploy/k8s/scripts/deploy.sh`](../deploy/k8s/scripts/deploy.sh) | builds the images, loads them into kind, `helm upgrade --install --wait --atomic` |
| [`deploy/k8s/scripts/load.sh`](../deploy/k8s/scripts/load.sh) | CPU load from inside the cluster, for the autoscaler |
| [`deploy/k8s/ci/`](../deploy/k8s/ci) | the checks the workflow runs (smoke, rolling update, rollback, self-healing, HPA) |

The images are the same ones the Docker kit builds from the [`Dockerfile`](../Dockerfile): the app
(`runner` target, Next.js standalone, user `node`) and the migration job (`migrator` target).

## The objects, in this project's words

**Pod.** One running copy of the relay: a container with `node server.js` listening on port 3000.
Pods are disposable. When one dies or is deleted, nothing repairs it; something above creates a
new one with a new name and a new IP.

**Deployment (and ReplicaSet).** "Keep N pods of webhook-relay version X running." The Deployment
`relay` owns a ReplicaSet per version; each ReplicaSet recreates pods that disappear. That is the
self-healing the lab tests: delete a pod and a replacement is Ready in a few seconds.

**Service.** A stable name and virtual IP (`relay`, port 80) in front of whichever pods are
*Ready* at the moment. Pods come and go; the Service's endpoint list follows their readiness. The
scheduler CronJob calls the app through it.

**Ingress (ingress-nginx).** The HTTP entrance from outside the cluster. The `relay` Ingress says
"send every path on any host to the `relay` Service"; the ingress-nginx controller (nginx running
in the cluster, bound to port 80 of the kind node) applies it and balances requests across the
Ready pods. In the lab, `http://localhost/api/ingest/<source>` on the runner lands on a pod.

**Probes.** How Kubernetes knows a pod's state, all on `GET /api/health` (which runs `select 1`):
- *startupProbe*: up to 60 s (2 s × 30) for Next.js to boot; the other probes wait for it.
- *readinessProbe*: every 5 s. Failing it removes the pod from the Service (no traffic) but does
  not restart it. Because it checks the database, a single pod that cannot reach Postgres stops
  receiving webhooks while the others take them. If the database itself is down, every pod fails
  it and the ingress answers 503 for everything until it is back.
- *livenessProbe*: every 10 s; after 6 failures in a row (one minute) the container is restarted.

**Rolling update.** How a new version replaces the old one inside the same Deployment:
`maxSurge: 1, maxUnavailable: 0` means "start one new pod, wait until it is Ready (plus
`minReadySeconds: 5`), only then stop one old pod", repeated until all pods run the new version.
There are never fewer Ready pods than desired. This replaces the blue-green switch of the Docker
kit.

**Graceful termination (preStop + grace period).** Stopping a pod without dropping requests: as
soon as the pod is marked for deletion, two things start in parallel: it is removed from the
endpoints, and `preStop` sleeps 10 s, so the pod keeps serving while nginx learns about the
removal. Then the container gets SIGTERM and Next.js stops accepting connections, finishes
in-flight requests and waits for pending `after()` callbacks (the first delivery attempt of
webhooks that were just accepted). Those attempts reach the built-in sinks through the Service
(`RELAY_INTERNAL_URL=http://relay:80`), not through the pod's own listener, which is already
closed at that point. `terminationGracePeriodSeconds: 60` is the hard limit before SIGKILL.

**Helm.** The package manager that turns the chart (templates + `values.yaml`) into Kubernetes
objects. Each `helm upgrade` creates a numbered *revision* of the *release* `relay`, so
`helm rollback relay <n>` can return to any earlier one. `deploy.sh` always runs
`helm upgrade --install --wait --atomic`: Helm waits until the rollout is Ready and, if it is not
within the timeout, rolls back by itself. The rollback covers Kubernetes objects only; a
migration that already ran stays applied (see limitations).

**Helm hook (migration Job).** The `relay-migrate` Job is annotated as a `pre-install,pre-upgrade`
hook: Helm runs the drizzle migrations and waits for the Job to succeed *before* touching the
Deployment. A failed migration stops the upgrade with the old version still serving. The Job reads
only the database Secret, which belongs to the separate `relay-postgres` release, so it exists on
the very first install.

**HPA (HorizontalPodAutoscaler) and metrics-server.** metrics-server collects CPU usage per pod
from the kubelets; the HPA `relay` compares the average with the target (50 % of the pod's CPU
request of 100m) and changes the Deployment's replica count between 2 and 5. The chart leaves
`replicas` out of the Deployment when the HPA is on, so a `helm upgrade` never resets what the
autoscaler decided.

**PodDisruptionBudget (PDB).** A promise for *voluntary* disruptions (node drain, cluster
upgrade): `minAvailable: 1` means the Eviction API refuses to evict a pod if that would leave
fewer than one Ready pod, so with N Ready pods it allows N - 1 evictions at a time. Pods that run
but are not Ready may always be evicted (`unhealthyPodEvictionPolicy: AlwaysAllow`), so they never
block a drain. It does not protect against crashes or plain `kubectl delete`.

**Job and CronJob.** A Job runs a pod to completion (the migration). A CronJob creates a Job on a
schedule: `relay-scheduler` calls `/api/cron/deliver` every minute with the `CRON_SECRET`,
replacing Vercel Cron and the Docker kit's scheduler container. It uses the app image (it already
has Node and `fetch`), so the lab pulls no extra image.

**ConfigMap and Secret.** Configuration as environment variables: the ConfigMap holds
non-secret values (`NEXT_PUBLIC_APP_URL`, `RELAY_INTERNAL_URL`), the Secret holds
`RELAY_ADMIN_TOKEN` and `CRON_SECRET`. The chart refuses to render without them (`required`), and
`values.yaml` has no real value. The lab generates random ones into `deploy/k8s/.lab/` (gitignored).
`DATABASE_URL` has no password (`postgres://relay@relay-postgres:5432/relay`): node-postgres takes
it from `PGPASSWORD`, which comes straight from the database Secret, so the password is never in a
values file and needs no URL encoding. A checksum annotation rolls the pods when either changes.

**StatefulSet and PersistentVolumeClaim (lab database).** Postgres runs as a StatefulSet with one
pod (`relay-postgres-0`, stable name) and a 1 Gi volume from kind's local-path provisioner. It is
there so the lab is self-contained. In production the relay would point at a managed Postgres
(`database.*` or `database.urlSecret` values) and this chart would not be installed.

**Security context.** The app runs as UID 1000 (`runAsNonRoot`), with a read-only root
filesystem (only `/app/.next/cache` and `/tmp` are writable `emptyDir` volumes), no Linux
capabilities, no privilege escalation, the runtime's default seccomp profile, and no Kubernetes
API token mounted.

## What CI checks

Every check talks to the cluster from outside, through `http://localhost` → ingress-nginx, the way
a webhook sender would. Traffic during a change is 4 workers calling `/api/health` plus one worker
sending signed webhooks every 0.2 s; **any** non-2xx response or timeout fails the job. The lab
turns off ingress-nginx's retry on another pod (`proxy-next-upstream: off`, in
[`deploy/k8s/lab-values.yaml`](../deploy/k8s/lab-values.yaml)), so a pod that refused a
connection while shutting down would show up as an error instead of being hidden by nginx.

| step | what it proves |
|---|---|
| Lint | shellcheck on the scripts, `helm lint --strict` on both charts, and the chart refuses to render without secrets |
| Cluster up | kind cluster, ingress-nginx and metrics-server ready |
| First install (v1) | migration hook, Postgres, app, HPA brings the Deployment to 2 Ready pods |
| Smoke test | health (driver `pg`), 401 without credentials, signed webhook delivered to the built-in sink, wrong signature 401, scheduler CronJob run on demand sends a queued delivery |
| Rolling update | `helm upgrade` v1 → v2 (new image) under traffic: zero failed requests, and every webhook accepted during the rollout ends up delivered |
| Rollback | upgrade to an image that crashes on boot: `--atomic` times out and rolls back, the old pods keep serving, zero failed requests |
| Self-healing + PDB | delete a pod: replacement Ready, zero failed requests; evict pods like a node drain (HPA frozen meanwhile): the PDB allows Ready - 1 evictions and refuses the next |
| HPA | in-cluster load on `/api/health`: replicas go above the minimum; the peak and the timeline are recorded |

### Results

<!-- results:start -->
Numbers from [run 38821942697](https://github.com/trichains/webhook-relay/actions/runs/38821942697)
(GitHub `ubuntu-24.04` runner, 4 vCPU; kind v0.33, Kubernetes 1.35.8, Helm 3.22; ingress-nginx
retries off). Each run prints the same tables in its job summary; the values vary a little from
run to run, and the same checks also passed in runs 38819257675 and 38820517015.

| check | result |
|---|---|
| smoke | signed webhook delivered in 1.2 s through the ingress; the scheduler CronJob, run on demand with the schedule suspended, claimed and sent a queued delivery |
| rolling update v1 → v2 (2 pods replaced) | 2,119 health requests + 146 signed webhooks while `deploy.sh` ran (28 s: build from cache, kind load, migration hook, rollout), **0 errors**, slowest response 0.22 s; 146/146 webhooks delivered on the first attempt |
| rollback (image that crashes on boot) | `helm upgrade --atomic` failed after 87 s (75 s timeout) and rolled back to revision 2 by itself (history: `3 failed`, `4 deployed: Rollback to 2`); 6,448 requests during the failed upgrade, **0 errors** |
| self-healing | deleted pod replaced by a Ready pod in **3.4 s**, 0 errors |
| PodDisruptionBudget | HPA frozen at 5 pods: 4 evictions allowed, the 5th refused ("would violate the pod's disruption budget"); 1,916 requests during deletion + evictions, 0 errors |
| HPA | from 2 pods (after an 87 s wait for the scale-down) to 3 pods 27 s after the load started and **5** pods at 43 s; peak average CPU 398 % of the request; 87,504 load requests, 0 errors |

The light test traffic alone (4 health workers + 1 webhook worker) is enough to push two pods past
50 % of a 100m CPU request, so the HPA sometimes adds pods during the rollout and rollback checks.
That is why the HPA check first waits, without traffic, for the scale-down to `minReplicas`.

An early run (before the built-in sinks went through the Service and before the delivery check
waited for retries) had 2 of 138 webhooks from the rollout still pending 150 s later, with zero
HTTP errors. The data to explain it was not collected in that run; since then the check reports
how many deliveries needed a retry, and it has been 0 in every run.
<!-- results:end -->

## Running it locally

Needs Docker, [kind](https://kind.sigs.k8s.io/docs/user/quick-start/#installation), `kubectl`,
`helm` 3, `jq`, `curl` and `openssl`, plus free ports 80/443 on 127.0.0.1. About 4 GB of RAM for the
image build and the cluster.

```bash
deploy/k8s/scripts/up.sh                 # cluster + ingress-nginx + metrics-server
deploy/k8s/scripts/deploy.sh --build v1  # build, load into kind, helm upgrade --install --wait --atomic
curl http://localhost/api/health         # {"ok":true,"driver":"pg","version":"v1"}

kubectl --context kind-webhook-relay-lab -n relay get deploy,pods,svc,ingress,hpa,pdb,cronjob
deploy/k8s/scripts/load.sh 120 32        # watch: kubectl ... get hpa -w
deploy/k8s/ci/rolling-update.sh v2      # any check from the workflow runs locally too

kind delete cluster --name webhook-relay-lab
```

The admin token for the dashboard and `/api/v1` is in `deploy/k8s/.lab/secrets.yaml`.

## Decisions

- **Database in a separate release.** A `pre-install` hook runs before the release's own objects
  exist. Keeping Postgres (and its Secret) in another release makes the migration hook work on the
  first install and keeps the data out of every app rollback.
- **`maxUnavailable: 0` + preStop.** Capacity never drops during a rollout, and the 10 s sleep
  covers the delay between "pod removed from endpoints" and "nginx stops sending to it". Without
  the sleep, the first requests after SIGTERM could hit a closing server.
- **No `replicas` with the HPA on.** Otherwise each `helm upgrade` would reset the pod count to the
  chart's number in the middle of a scale-up.
- **Load generated inside the cluster, through the ingress.** New connections per request, so
  nginx spreads them over every Ready pod, including the ones the HPA just added.
- **Helm 3 with `--atomic`.** Helm 4 renamed the flag (`--rollback-on-failure`); the lab pins
  Helm 3.22 so the commands match most of the documentation people will read.

## Limitations

Honest list of what this lab does **not** prove or provide:

- **One node, in Docker, on a CI runner.** No real node failure, no multi-zone scheduling, no
  network latency between nodes. The HPA scales pods that share the same 4 CPUs of the runner, so
  scaling adds isolation and spreads the load but not real extra capacity.
- **ingress-nginx is retired upstream** (best-effort maintenance ended in March 2026, no more
  security fixes). It is used here because it is the classic Ingress controller to learn on, pinned
  to its last release (v1.15.1, which supports Kubernetes up to 1.35, hence the 1.35 node image). A
  new cluster should use a [Gateway API](https://gateway-api.sigs.k8s.io/) implementation.
- **No TLS.** HTTP only; a real cluster would add cert-manager and HTTPS on the Ingress.
- **Lab database.** One Postgres pod, no replication, no failover, no backups inside Kubernetes
  (the Docker kit's backup/restore was not ported). Production: a managed Postgres.
- **`--atomic` does not undo migrations.** The migration hook runs before the rollout; if the
  rollout then fails, the app goes back to the previous version but the schema stays migrated.
  Migrations therefore have to be backward compatible (expand first, remove columns in a later
  release). The rollback test uses an unchanged migration image, so it does not exercise this.
- **Long work at shutdown.** The grace period is 60 s. A queue pass claims up to 50 deliveries and
  each attempt may take up to the destination's timeout (max 30 s); a pass that is still running
  when SIGKILL arrives leaves rows in `processing` until the 5-minute stale-lock reclaim, and those
  deliveries can be sent twice (the relay is at-least-once anyway).
- **Liveness also depends on the database**, because `/api/health` is the only health endpoint. The
  probe is lenient (one minute) but a long database outage would restart the app pods. A real setup
  would split liveness (process alive) from readiness (dependencies ok).
- **Only graceful disruptions are tested.** Pod deletion and eviction go through preStop and
  SIGTERM. A hard crash (OOM kill, SIGKILL) can still fail the requests in flight on that pod.
- **Secrets.** Kubernetes Secrets are base64, not encrypted, unless the cluster enables encryption
  at rest; the lab stores them in a local gitignored file. Production: External Secrets, Sealed
  Secrets or the cloud's secret manager.
- **No NetworkPolicy, ResourceQuota, monitoring or alerting** in the cluster. The Docker kit's
  monitor (queue, disk, backup age) was not ported.
- **Scheduler granularity is one minute** (CronJob minimum), against 30 s in the Docker kit.
- **No registry.** Images are copied into the node with `kind load`; no signing or scanning.
- `metrics-server` runs with `--kubelet-insecure-tls` because kind's kubelets use self-signed
  certificates. Never on a real cluster.
