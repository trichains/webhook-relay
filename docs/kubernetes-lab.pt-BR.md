# Laboratório de Kubernetes

[English](kubernetes-lab.md) · [Self-hosting (Docker)](self-hosting.pt-BR.md)

Este é um **laboratório de estudo**: o webhook-relay empacotado como um chart Helm e exercitado
num cluster [kind](https://kind.sigs.k8s.io/) (Kubernetes dentro do Docker) descartável, em todo
pull request, no [`.github/workflows/k8s-lab.yml`](../.github/workflows/k8s-lab.yml). O objetivo é
aprender e provar, com números, como o Kubernetes mantém o relay no ar enquanto ele é atualizado,
revertido, quebrado e posto sob carga. Não é uma configuração de produção e nunca atendeu tráfego
real: a seção de [limitações](#limitações) lista o que um cluster de verdade ainda precisaria.

Para rodar o relay no seu próprio servidor hoje, use o [kit Docker](self-hosting.pt-BR.md).

## O que roda

```
                http://localhost (porta 80 do nó do kind)
 quem envia     ──▶ ingress-nginx ──▶ Service relay ──▶ Pod relay-…  ┐  Deployment relay
 webhooks e o CI     (Ingress relay)                ──▶ Pod relay-…  ┤  (2 a 5 pods, HPA)
                                                                     │
 CronJob relay-scheduler (a cada minuto) ──▶ Service relay /api/cron/deliver
 Job relay-migrate (hook do Helm, antes de cada install/upgrade)     │
                                                                     ▼
                                  Service relay-postgres ──▶ StatefulSet relay-postgres + PVC
```

| arquivo | o que é |
|---|---|
| [`deploy/k8s/chart/webhook-relay`](../deploy/k8s/chart/webhook-relay) | o chart do app: Deployment, Service, Ingress, HPA, PodDisruptionBudget, Job de migração, CronJob do scheduler, ConfigMap, Secret, ServiceAccount |
| [`deploy/k8s/chart/postgres-lab`](../deploy/k8s/chart/postgres-lab) | um pod de Postgres 17 com volume persistente, em uma release Helm própria. Só para o lab |
| [`deploy/k8s/kind-config.yaml`](../deploy/k8s/kind-config.yaml) | cluster de um nó, portas 80/443 do host mapeadas para o ingress controller |
| [`deploy/k8s/scripts/up.sh`](../deploy/k8s/scripts/up.sh) | cria o cluster e instala ingress-nginx e metrics-server (versões fixadas) |
| [`deploy/k8s/scripts/deploy.sh`](../deploy/k8s/scripts/deploy.sh) | gera as imagens, carrega no kind, `helm upgrade --install --wait --atomic` |
| [`deploy/k8s/scripts/load.sh`](../deploy/k8s/scripts/load.sh) | carga de CPU de dentro do cluster, para o autoscaler |
| [`deploy/k8s/ci/`](../deploy/k8s/ci) | as verificações que o workflow roda (smoke, rolling update, rollback, autocura, HPA) |

As imagens são as mesmas que o kit Docker gera a partir do [`Dockerfile`](../Dockerfile): o app
(target `runner`, Next.js standalone, usuário `node`) e o job de migração (target `migrator`).

## Os objetos, com as palavras do projeto

**Pod.** Uma cópia do relay rodando: um container com `node server.js` ouvindo na porta 3000.
Pods são descartáveis. Quando um morre ou é apagado, ninguém conserta aquele pod; algo acima dele
cria outro, com outro nome e outro IP.

**Deployment (e ReplicaSet).** "Mantenha N pods do webhook-relay na versão X rodando." O
Deployment `relay` tem um ReplicaSet por versão; cada ReplicaSet recria os pods que somem. É essa a
autocura que o lab testa: apague um pod e um substituto fica Ready em poucos segundos.

**Service.** Um nome e um IP virtual estáveis (`relay`, porta 80) na frente dos pods que estão
*Ready* naquele momento. Pods vêm e vão; a lista de endpoints do Service acompanha a prontidão
deles. O CronJob do scheduler chama o app por ele.

**Ingress (ingress-nginx).** A entrada HTTP de fora do cluster. O Ingress `relay` diz "mande
qualquer caminho, em qualquer host, para o Service `relay`"; o controller ingress-nginx (um nginx
rodando no cluster, escutando na porta 80 do nó do kind) aplica essa regra e distribui as requisições
entre os pods Ready. No lab, `http://localhost/api/ingest/<source>` no runner chega a um pod.

**Probes.** Como o Kubernetes sabe o estado de um pod, todas em `GET /api/health` (que roda
`select 1`):
- *startupProbe*: até 60 s (2 s × 30) para o Next.js subir; as outras probes esperam por ela.
- *readinessProbe*: a cada 5 s. Falhar tira o pod do Service (sem tráfego), mas não reinicia.
  Como ela checa o banco, um pod sozinho que não alcança o Postgres para de receber webhooks
  enquanto os outros atendem. Se o próprio banco cair, todos os pods falham nela e o ingress
  responde 503 para tudo até ele voltar.
- *livenessProbe*: a cada 10 s; depois de 6 falhas seguidas (um minuto) o container é reiniciado.

**Rolling update.** Como uma versão nova substitui a antiga dentro do mesmo Deployment:
`maxSurge: 1, maxUnavailable: 0` quer dizer "suba um pod novo, espere ficar Ready (mais
`minReadySeconds: 5`), só então pare um pod antigo", repetindo até todos estarem na versão nova.
Nunca há menos pods Ready do que o desejado. Isso substitui a troca blue-green do kit Docker.

**Encerramento gracioso (preStop + grace period).** Parar um pod sem derrubar requisições: assim
que o pod é marcado para remoção, duas coisas começam em paralelo: ele sai dos endpoints e o
`preStop` dorme 10 s, então o pod continua atendendo enquanto o nginx fica sabendo da remoção.
Depois o container recebe SIGTERM e o Next.js para de aceitar conexões, termina as requisições em
andamento e espera os callbacks de `after()` pendentes (a primeira tentativa de entrega dos
webhooks recém-aceitos). Essas tentativas chegam aos sinks embutidos pelo Service
(`RELAY_INTERNAL_URL=http://relay:80`), e não pelo listener do próprio pod, que nessa hora já
fechou. `terminationGracePeriodSeconds: 60` é o limite antes do SIGKILL.

**Helm.** O gerenciador de pacotes que transforma o chart (templates + `values.yaml`) em objetos
do Kubernetes. Cada `helm upgrade` cria uma *revision* numerada da *release* `relay`, então
`helm rollback relay <n>` volta para qualquer uma anterior. O `deploy.sh` sempre roda
`helm upgrade --install --wait --atomic`: o Helm espera o rollout ficar Ready e, se não ficar
dentro do timeout, faz o rollback sozinho. O rollback cobre só os objetos do Kubernetes; uma
migration que já rodou continua aplicada (veja as limitações).

**Hook do Helm (Job de migração).** O Job `relay-migrate` é anotado como hook
`pre-install,pre-upgrade`: o Helm roda as migrations do drizzle e espera o Job dar certo *antes*
de mexer no Deployment. Uma migration com falha interrompe o upgrade, com a versão antiga ainda no ar. O
Job lê só o Secret do banco, que pertence à release separada `relay-postgres`, então ele já existe
na primeira instalação.

**HPA (HorizontalPodAutoscaler) e metrics-server.** O metrics-server coleta o uso de CPU de cada
pod nos kubelets; o HPA `relay` compara a média com a meta (50 % do request de CPU do pod, 100m) e
muda o número de réplicas do Deployment entre 2 e 5. O chart omite `replicas` do Deployment
quando o HPA está ligado, para um `helm upgrade` nunca desfazer o que o autoscaler decidiu.

**PodDisruptionBudget (PDB).** Uma promessa para interrupções *voluntárias* (drain de nó, upgrade
do cluster): `minAvailable: 1` faz a Eviction API recusar a remoção (eviction) de um pod se isso
deixar menos de um pod Ready; com N pods Ready, ela permite N - 1 evictions de cada vez. Pods
rodando mas não Ready sempre podem sair (`unhealthyPodEvictionPolicy: AlwaysAllow`), para nunca
travarem um drain. Não protege contra crash nem contra um `kubectl delete` direto.

**Job e CronJob.** Um Job roda um pod até terminar (a migração). Um CronJob cria Jobs conforme
um agendamento: o `relay-scheduler` chama `/api/cron/deliver` a cada minuto com o `CRON_SECRET`,
substituindo o Vercel Cron e o container scheduler do kit Docker. Ele usa a imagem do app (que já
tem Node e `fetch`), então o lab não baixa nenhuma imagem extra.

**ConfigMap e Secret.** Configuração como variáveis de ambiente: o ConfigMap guarda os valores
não secretos (`NEXT_PUBLIC_APP_URL`, `RELAY_INTERNAL_URL`), o Secret guarda `RELAY_ADMIN_TOKEN` e
`CRON_SECRET`. O chart se recusa a renderizar sem eles (`required`), e o `values.yaml` não tem
nenhum valor real. O lab gera valores aleatórios em `deploy/k8s/.lab/` (no `.gitignore`). O
`DATABASE_URL` não tem senha (`postgres://relay@relay-postgres:5432/relay`): o node-postgres pega
a senha do `PGPASSWORD`, que vem direto do Secret do banco, então ela nunca fica num arquivo de
values e não precisa de URL-encoding. Uma anotação de checksum recria os pods (novo rollout)
quando um dos dois muda.

**StatefulSet e PersistentVolumeClaim (banco do lab).** O Postgres roda como StatefulSet com um
pod (`relay-postgres-0`, nome estável) e um volume de 1 Gi do provisionador local-path do kind.
Ele existe para o lab ser autocontido. Em produção o relay apontaria para um Postgres gerenciado
(values `database.*` ou `database.urlSecret`) e este chart não seria instalado.

**Security context.** O app roda com UID 1000 (`runAsNonRoot`), sistema de arquivos raiz somente
leitura (só `/app/.next/cache` e `/tmp` são volumes `emptyDir` graváveis), sem capabilities do
Linux, sem escalada de privilégio, com o perfil seccomp padrão do runtime e sem token da API do
Kubernetes montado.

## O que o CI verifica

Toda verificação fala com o cluster de fora, por `http://localhost` → ingress-nginx, como um
remetente de webhook faria. O tráfego durante cada mudança é de 4 workers chamando `/api/health`
mais um worker mandando webhooks assinados a cada 0,2 s; **qualquer** resposta fora de 2xx ou
timeout reprova o job. O lab desliga o retry do ingress-nginx em outro pod
(`proxy-next-upstream: off`, em [`deploy/k8s/lab-values.yaml`](../deploy/k8s/lab-values.yaml)),
para que um pod que recusasse conexão durante o desligamento aparecesse como erro, em vez de ser
escondido pelo nginx.

| etapa | o que prova |
|---|---|
| Lint | shellcheck nos scripts, `helm lint --strict` nos dois charts, e o chart se recusa a renderizar sem segredos |
| Cluster up | cluster kind, ingress-nginx e metrics-server prontos |
| Primeira instalação (v1) | hook de migração, Postgres, app, o HPA leva o Deployment a 2 pods Ready |
| Smoke test | health (driver `pg`), 401 sem credenciais, webhook assinado entregue no sink embutido, assinatura errada 401, CronJob do scheduler rodado sob demanda envia uma entrega enfileirada |
| Rolling update | `helm upgrade` v1 → v2 (imagem nova) com tráfego: zero requisições com erro, e todo webhook aceito durante o rollout termina entregue |
| Rollback | upgrade para uma imagem que quebra no boot: o `--atomic` estoura o timeout e reverte, os pods antigos seguem atendendo, zero requisições com erro |
| Autocura + PDB | apagar um pod: substituto Ready, zero requisições com erro; evictions como num drain de nó (com o HPA congelado): o PDB permite Ready - 1 evictions e recusa a seguinte |
| HPA | carga dentro do cluster em `/api/health`: as réplicas passam do mínimo; o pico e a linha do tempo ficam registrados |

### Resultados

<!-- results:start -->
Números da [execução 38819257675](https://github.com/trichains/webhook-relay/actions/runs/38819257675)
(runner `ubuntu-24.04` do GitHub, 4 vCPU; kind v0.33, Kubernetes 1.35.8, Helm 3.22). Cada execução
imprime as mesmas tabelas no resumo do job; os valores variam um pouco entre execuções.

| verificação | resultado |
|---|---|
| smoke | webhook assinado entregue em cerca de 1 s pelo ingress; o CronJob do scheduler enviou uma entrega enfileirada |
| rolling update v1 → v2 (2 pods substituídos) | 3.576 requisições de health + 249 webhooks assinados durante o rollout, **0 erros**, resposta mais lenta 0,28 s; 249/249 webhooks entregues na primeira tentativa |
| rollback (imagem que quebra no boot) | o `helm upgrade --atomic` falhou depois de 88 s (timeout de 75 s) e voltou sozinho para a revision 2; 6.192 requisições durante o upgrade com falha, **0 erros** |
| auto-cura | pod apagado substituído por um pod Ready em **3,5 s**, 0 erros |
| PodDisruptionBudget | com 5 pods, 4 despejos permitidos e o 5º recusado ("would violate the pod's disruption budget"), 0 erros |
| HPA | de 2 pods (depois de esperar o scale-down) para **5** pods 27 s após o início da carga; pico de CPU média de 355 % do request; 59.433 requisições de carga, 0 erros |

Uma execução anterior (antes de a verificação de entrega esperar os retries) teve 2 de 138
webhooks do rollout ainda pendentes 150 s depois dele, com zero erros HTTP; agora a verificação
espera até 390 s e informa quantas entregas precisaram de retry, então isso aparece nos números se
acontecer de novo. Durante o rollout o HPA foi a 5 pods: o build no runner e o tráfego de teste
passam da meta de 50 % de um request de 100m, e por isso a verificação do HPA espera o scale-down
antes de começar.
<!-- results:end -->

## Rodando localmente

Precisa de Docker, [kind](https://kind.sigs.k8s.io/docs/user/quick-start/#installation),
`kubectl`, `helm` 3, `jq`, `curl` e `openssl`, além das portas 80/443 livres em 127.0.0.1. Uns 4 GB
de RAM para o build da imagem e o cluster.

```bash
deploy/k8s/scripts/up.sh                 # cluster + ingress-nginx + metrics-server
deploy/k8s/scripts/deploy.sh --build v1  # build, carrega no kind, helm upgrade --install --wait --atomic
curl http://localhost/api/health         # {"ok":true,"driver":"pg","version":"v1"}

kubectl --context kind-webhook-relay-lab -n relay get deploy,pods,svc,ingress,hpa,pdb,cronjob
deploy/k8s/scripts/load.sh 120 32        # acompanhe: kubectl ... get hpa -w
deploy/k8s/ci/rolling-update.sh v2      # qualquer verificação do workflow roda localmente também

kind delete cluster --name webhook-relay-lab
```

O token de admin do dashboard e da `/api/v1` fica em `deploy/k8s/.lab/secrets.yaml`.

## Decisões

- **Banco numa release separada.** Um hook `pre-install` roda antes de os objetos da própria
  release existirem. Deixar o Postgres (e o Secret dele) em outra release faz o hook de migração
  funcionar na primeira instalação e mantém os dados fora de qualquer rollback do app.
- **`maxUnavailable: 0` + preStop.** A capacidade nunca cai durante um rollout, e os 10 s de sleep
  cobrem o atraso entre "pod saiu dos endpoints" e "o nginx parou de mandar para ele". Sem o sleep,
  as primeiras requisições depois do SIGTERM poderiam cair num servidor fechando.
- **Sem `replicas` com o HPA ligado.** Senão cada `helm upgrade` voltaria o número de pods para o
  valor do chart no meio de um scale-up.
- **Carga gerada dentro do cluster, passando pelo ingress.** Conexão nova a cada requisição, então
  o nginx espalha a carga por todos os pods Ready, inclusive os que o HPA acabou de criar.
- **Helm 3 com `--atomic`.** O Helm 4 renomeou a flag (`--rollback-on-failure`); o lab fixa o Helm
  3.22 para os comandos baterem com a maior parte da documentação que as pessoas vão ler.

## Limitações

Lista honesta do que este lab **não** prova nem entrega:

- **Um nó, dentro do Docker, num runner de CI.** Sem falha real de nó, sem distribuição entre
  zonas, sem latência de rede entre nós. O HPA escala pods que dividem as mesmas 4 CPUs do runner:
  escalar dá isolamento e espalha a carga, mas não capacidade extra de verdade.
- **O ingress-nginx foi aposentado** pelo projeto (manutenção best-effort terminou em março de
  2026, sem novas correções de segurança). Ele é usado aqui por ser o Ingress controller clássico
  para aprender, fixado na última release (v1.15.1, que suporta Kubernetes até 1.35, por isso a
  imagem de nó 1.35). Um cluster novo deveria usar uma implementação de
  [Gateway API](https://gateway-api.sigs.k8s.io/).
- **Sem TLS.** Só HTTP; um cluster de verdade adicionaria cert-manager e HTTPS no Ingress.
- **Banco de laboratório.** Um pod de Postgres, sem replicação, sem failover, sem backups dentro do
  Kubernetes (o backup/restore do kit Docker não foi portado). Produção: Postgres gerenciado.
- **O `--atomic` não desfaz migrations.** O hook de migração roda antes do rollout; se o rollout
  falhar depois, o app volta para a versão anterior mas o schema continua migrado. Por isso as
  migrations precisam ser compatíveis com a versão anterior (primeiro expandir, remover colunas
  numa release seguinte). O teste de rollback usa a mesma imagem de migração, então não exercita
  isso.
- **Trabalho longo no desligamento.** O grace period é de 60 s. Uma passada da fila reivindica até
  50 entregas e cada tentativa pode levar até o timeout da destination (no máximo 30 s); uma
  passada ainda rodando quando chega o SIGKILL deixa linhas em `processing` até a recuperação de
  lock vencido (5 min), e essas entregas podem sair duas vezes (o relay já é at-least-once).
- **A liveness também depende do banco**, porque `/api/health` é o único endpoint de saúde. A
  probe é tolerante (um minuto), mas uma queda longa do banco reiniciaria os pods do app. Um setup
  real separaria liveness (processo vivo) de readiness (dependências ok).
- **Só interrupções graciosas são testadas.** Apagar pods e removê-los por eviction passa por preStop e SIGTERM.
  Um crash duro (OOM kill, SIGKILL) ainda pode derrubar as requisições em andamento naquele pod.
- **Segredos.** Secrets do Kubernetes são base64, não criptografados, a menos que o cluster ative
  criptografia em repouso; o lab guarda os valores num arquivo local fora do git. Produção:
  External Secrets, Sealed Secrets ou o gerenciador de segredos da nuvem.
- **Sem NetworkPolicy, ResourceQuota, monitoramento nem alertas** no cluster. O monitor do kit
  Docker (fila, disco, idade do backup) não foi portado.
- **O scheduler roda de minuto em minuto** (mínimo do CronJob), contra 30 s no kit Docker.
- **Sem registry.** As imagens são copiadas para o nó com `kind load`; sem assinatura nem scan.
- O `metrics-server` roda com `--kubelet-insecure-tls` porque os kubelets do kind usam
  certificados autoassinados. Nunca num cluster de verdade.
