# Self-hosting do webhook-relay (Docker)

[English](self-hosting.md) · [Runbook](runbook.pt-BR.md)

O webhook-relay roda na Vercel sem configuração extra. Este kit roda ele em um servidor Linux que
você controla, com HTTPS, deploys blue-green sem downtime, backups agendados, alertas e um script
de diagnóstico. O fluxo inteiro (deploy, troca sem downtime, rollback de uma release quebrada,
backup/restore, alerta de queda) roda em todo pull request em
[`.github/workflows/selfhost.yml`](../.github/workflows/selfhost.yml), em um runner do GitHub
com a CA interna do Caddy. Trate isso como um kit testado, não como um serviço gerenciado: o
servidor, as atualizações dele e a cópia externa dos seus backups continuam sendo responsabilidade sua.

## O que roda

```
                    :80 / :443 (HTTP/1.1, HTTP/2, HTTP/3)
 webhook senders ──▶ caddy ──▶ app_blue  ─┐   (one color live,
                       │   └─▶ app_green ─┤    the other idle)
                       │ :8080 (internal) ├──▶ postgres (volume pgdata)
     scheduler ────────┤                  │
     monitor ──────────┘  ─ alerts ─▶ ALERT_WEBHOOK_URL
     backup  ── pg_dump ─▶ deploy/backups/*.dump
```

| serviço | o que faz |
|---|---|
| `postgres` | Postgres 17, dados no volume `pgdata`, sem porta publicada no host |
| `migrate` | job único: migrations do drizzle sob um advisory lock, executado pelo `deploy.sh` antes de cada release |
| `app_blue`, `app_green` | a imagem da aplicação (Next.js standalone, sem root, `HEALTHCHECK` em `/api/health`). Só uma fica no ar |
| `caddy` | proxy reverso, HTTPS automático (Let's Encrypt/ZeroSSL) ou `tls internal`, redirecionamento HTTP→HTTPS, HSTS, access log em JSON |
| `scheduler` | chama `/api/cron/deliver` a cada `SCHEDULER_INTERVAL_SECONDS` (substitui o Vercel Cron) |
| `backup` | `pg_dump` a cada `BACKUP_INTERVAL_SECONDS`, verificado, com checksum, mantém os `BACKUP_KEEP` mais recentes |
| `monitor` | verifica health, banco, fila, disco e idade do backup; alertas com debounce para um webhook |

Todos os containers usam o driver `json-file` do Docker com rotação (10 MB × 5 arquivos por container),
então os logs não conseguem encher o disco.

## Requisitos

- Uma VPS Linux (Ubuntu 24.04 ou Debian 12 testados em espírito; o CI roda Ubuntu 24.04). 1 vCPU / 1 GB de RAM
  dá conta de volumes pequenos; 2 GB é confortável para buildar a imagem no servidor.
- Docker Engine 25+ com o plugin Compose (`docker compose version` ≥ 2.24).
- Um domínio (ou subdomínio) que você consiga apontar para o servidor.
- Portas 80 e 443 acessíveis pela internet (o Let's Encrypt valida por elas).

## 1. Preparar o servidor

```bash
# Docker (script oficial de conveniência; leia antes se preferir: https://get.docker.com)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # saia e entre de novo na sessão

# Firewall: só SSH, HTTP e HTTPS. Libere o SSH *antes* de ativar o ufw.
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp            # HTTP/3 (opcional)
sudo ufw enable
```

> O Docker publica portas com as próprias regras de iptables, que passam por cima do ufw. Esta stack
> só publica 80/443 (Caddy); o Postgres e as aplicações só são acessíveis pela rede interna do
> Docker. Não adicione `ports:` ao `postgres` sem entender isso.

## 2. DNS

Crie um registro `A` (e `AAAA`, se o servidor tiver IPv6) para o seu domínio apontando para o servidor,
por exemplo `relay.example.com → 203.0.113.10`. Espere até `dig +short relay.example.com`
retornar o endereço do servidor antes do primeiro deploy; senão o certificado não tem como ser emitido
(veja [runbook: certificado não emitido](runbook.pt-BR.md#5-certificado-não-emitido)).

## 3. Configurar

```bash
git clone https://github.com/trichains/webhook-relay.git
cd webhook-relay/deploy
cp .env.example .env
chmod 600 .env
```

Edite o `deploy/.env`:

| variável | valor |
|---|---|
| `DOMAIN` | `relay.example.com` |
| `CADDY_TLS` | seu e-mail (conta ACME do Let's Encrypt), ou `internal` para uma CA privada |
| `POSTGRES_PASSWORD`, `RELAY_ADMIN_TOKEN`, `CRON_SECRET` | `openssl rand -hex 32` para cada um (só hex: a senha vai dentro de uma URL) |
| `ALERT_WEBHOOK_URL` | URL de webhook do Discord, um hook compatível com Slack, ou `https://ntfy.sh/<topic>` com `ALERT_FORMAT=text` |

As outras variáveis têm defaults razoáveis e estão documentadas no próprio arquivo. O `deploy/.env` está
no gitignore; nunca faça commit dele.

## 4. Primeiro deploy

```bash
./scripts/deploy.sh --build v1
```

Isso builda a imagem a partir do seu checkout (`webhook-relay:v1` e `webhook-relay-migrate:v1`),
sobe o Postgres e o Caddy, roda as migrations, sobe o `app_blue`, espera ele ficar healthy,
aponta o Caddy para ele e sobe os serviços scheduler, backup e monitor. Depois:

```bash
curl https://relay.example.com/api/health
# {"ok":true,"driver":"pg","version":"v1"}
```

O dashboard fica em `https://relay.example.com/dashboard` (HTTP Basic auth, qualquer usuário, senha
= `RELAY_ADMIN_TOKEN`). Crie uma source lá e aponte os webhooks da sua plataforma para a URL de ingest
que ela mostra.

## 5. Deploy de uma nova versão (sem downtime)

```bash
git pull
./scripts/deploy.sh --build v2          # ou: --image ghcr.io/<you>/webhook-relay:v2
```

O que o `deploy.sh` faz, em ordem:

1. Pega um lock (um deploy por vez) e resolve a imagem (build, pull ou `--rollback`).
2. Roda o job de migrations. Se falhar, nada mais acontece e a cor no ar continua atendendo.
3. Sobe a cor ociosa com a nova imagem e espera o health check do Docker
   (`HEALTH_TIMEOUT_SECONDS`, padrão 120). Se o container sair, reiniciar ou ficar unhealthy,
   ele é removido e o script sai com código diferente de zero: **rollback automático**, o proxy nunca trocou.
4. Testa a nova cor de dentro do container do Caddy (o mesmo caminho de rede que o proxy vai usar).
5. Reescreve o `runtime/caddy/upstream.caddy` e roda `caddy reload`, uma troca de config graciosa:
   as requisições em andamento terminam na cor antiga, as novas vão para a nova.
6. Verifica `/api/health` 5 vezes pelo proxy; se falhar, aponta o Caddy de volta.
7. Espera `DRAIN_SECONDS` (15) e então para a cor antiga com `SIGTERM` e 30 s de tolerância.
   O `init: true` garante que o sinal chegue ao Node, então as requisições em andamento e os callbacks de `after()`
   (primeiras tentativas de entrega) terminam.

O CI mede isso em todo PR com tráfego HTTPS contínuo durante o deploy e falha com qualquer
erro ou timeout; veja o resumo do job do workflow "Self-hosting".

Rollback para a imagem anterior (nenhuma migration é executada):

```bash
./scripts/deploy.sh --rollback
```

**Migrations e rollback.** As duas cores falam com o mesmo banco, e a migration roda antes
da troca, então a versão antiga roda por um instante contra o schema novo. Mantenha as migrations
retrocompatíveis (expandir, fazer o deploy e contrair numa release seguinte) e o rollback continua seguro.

**Várias instâncias da aplicação.** Blue e green são builds separados, então um formulário do dashboard renderizado pela
versão antiga e enviado depois da troca pode falhar com "Failed to find Server Action"; recarregue
a página. Definir `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` no momento do build mantém a chave estável entre
builds. O ingest de webhooks e a API são route handlers simples e não são afetados.

## 6. Backups

O serviço `backup` grava `deploy/backups/<db>-<UTC timestamp>.dump` (formato custom do pg_dump)
mais um `.sha256`, verifica se cada dump é legível antes de guardá-lo e apaga todos exceto os
`BACKUP_KEEP` mais recentes. O monitor alerta quando o dump mais recente é mais antigo que
`BACKUP_MAX_AGE_SECONDS`.

```bash
./scripts/backup.sh                                     # backup agora, mostra o arquivo
./scripts/restore.sh backups/relay-20261015T030000Z.dump  # pede confirmação
```

O `restore.sh` verifica o checksum, faz um backup de segurança do estado atual, pausa o
scheduler, restaura em uma única transação (tudo ou nada) e retoma o scheduler.

### Backups externos

Um backup no mesmo disco não sobrevive à perda do servidor. Copie `deploy/backups` para outro lugar,
por exemplo com o [rclone](https://rclone.org) para qualquer bucket compatível com S3, pelo crontab do host:

```cron
# 03:30 todo dia: espelha os dumps novos no bucket (nunca apaga arquivos remotos)
30 3 * * * rclone copy /home/deploy/webhook-relay/deploy/backups remote:relay-backups --include "*.dump*"
```

De vez em quando, teste um restore a partir da cópia externa: copie um dump de volta para `deploy/backups` e
rode o `restore.sh` em um servidor de staging. Backup que nunca foi restaurado é esperança, não backup.

## 7. Logs

As aplicações, o Caddy e os containers de operação gravam um objeto JSON por linha.

```bash
./scripts/dc.sh logs -f --since 10m app_blue app_green          # logs da aplicação ao vivo
./scripts/dc.sh logs --no-log-prefix --since 1h app_green \
  | jq -c 'select(.level == "error")'                           # só erros
./scripts/dc.sh logs --no-log-prefix --since 1h caddy \
  | jq -c 'select(.status >= 500) | {ts, status, uri: .request.uri, upstream: .upstream_addr?}'
./scripts/dc.sh logs --no-log-prefix --since 1h app_green \
  | jq -r 'select(.event == "ingest.accepted") | .source' | sort | uniq -c   # webhooks por source
```

O `dc.sh` é o `docker compose` com os arquivos, o env e o estado de deploy desta stack; ele também enxerga
os profiles `app_blue`/`app_green`, que um `docker compose ps` puro esconderia.

## 8. Alertas

O monitor roda a cada `MONITOR_INTERVAL_SECONDS` e verifica:

| verificação | dispara quando |
|---|---|
| `health` | `/api/health` pelo proxy não retorna 200 / `ok:true` |
| `database` | o monitor não consegue consultar o Postgres |
| `queue` | uma entrega vencida esperou mais que `QUEUE_STUCK_SECONDS` (worker parado) ou há mais de `QUEUE_MAX_PENDING` na fila |
| `disk` | o filesystem do host onde fica `deploy/backups` passou de `DISK_MAX_PERCENT` |
| `backup` | o dump mais recente é mais antigo que `BACKUP_MAX_AGE_SECONDS` (ou não existe nenhum) |

Uma verificação alerta depois de `MONITOR_FAILURES_BEFORE_ALERT` falhas seguidas, repete no máximo a cada
`ALERT_REPEAT_SECONDS` enquanto continuar falhando e envia um `resolved` quando volta ao normal. Payload
(`ALERT_FORMAT=json`):

```json
{"content":"[webhook-relay-prod] FIRING health: GET http://caddy:8080/api/health -> status=502 ...",
 "text":"...same...","status":"firing","check":"health","message":"...","instance":"webhook-relay-prod","ts":"2026-10-15T21:10:03Z"}
```

O Discord lê `content`, hooks no estilo Slack leem `text` e o seu próprio receptor recebe os campos
estruturados. Para o ntfy, defina `ALERT_FORMAT=text` e `ALERT_WEBHOOK_URL=https://ntfy.sh/<topic>`.
Para testar o caminho de ponta a ponta, pare a aplicação no ar por um minuto:
`./scripts/dc.sh stop app_blue`, espere o alerta, `./scripts/dc.sh start app_blue`.

## 9. Quando algo quebrar

```bash
./scripts/diagnose.sh            # containers, health, erros recentes, conexões do Postgres,
SINCE=2h ./scripts/diagnose.sh   # fila, disco, backups: só leitura
```

Depois siga o [runbook](runbook.pt-BR.md).

## Referência

- Imagem: `Dockerfile` (targets `runner`, o padrão, e `migrator`). Buildada com
  `NEXT_OUTPUT=standalone`; os builds da Vercel não definem essa variável e continuam iguais.
- `RELAY_INTERNAL_URL=http://127.0.0.1:3000` (definida pelo arquivo compose): entregas para os receptores
  embutidos em `/api/sink/*` ficam dentro do container em vez de sair pelo domínio.
- Estado de runtime: `deploy/runtime/state.env` (cor no ar, imagens, imagem anterior) e
  `deploy/runtime/caddy/upstream.caddy`. Os dois estão no gitignore e são controlados pelo `deploy.sh`.
- Limitações: um servidor, um Postgres (sem réplica, sem PITR: o ponto de recuperação é o último dump);
  o build roda no servidor, a menos que você publique as imagens em um registry; sem stack de métricas
  (Prometheus/Grafana), só verificações e alertas.
