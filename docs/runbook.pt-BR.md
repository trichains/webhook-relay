# Runbook: webhook-relay self-hosted

[English](runbook.md) · [Guia de self-hosting](self-hosting.pt-BR.md) · [Incidentes](incidents/)

Os comandos rodam a partir de `deploy/` no servidor. `./scripts/dc.sh` é o `docker compose` desta stack.

## Como conduzir um incidente

1. **Primeiro registre o estado, depois mexa.** `./scripts/diagnose.sh > /tmp/diag-$(date +%s).txt`. Ele é
   só leitura e captura o que um restart apagaria (logs, estado das conexões, contagem de restarts).
2. **Estanque o problema** se houver usuários afetados: `./scripts/deploy.sh --rollback` quando o problema
   começou com um deploy; caso contrário, reinicie o serviço que caiu. Quem envia webhooks faz retry, e todo
   evento aceito está no Postgres, então uma queda curta não perde nada depois que o ingest volta.
3. **Ache a causa raiz** usando a seção correspondente abaixo. Um restart que "resolve" só trata o
   sintoma; anote por que quebrou.
4. **Corrija a causa e depois verifique** com o mesmo comando que mostrou o problema.
5. **Documente** em `docs/incidents/` (modelo: [o primeiro incidente](incidents/)): linha do tempo,
   impacto, causa raiz, correção e o que evita que se repita.

Úteis em qualquer situação:

```bash
./scripts/dc.sh ps -a                                        # what runs, health, restarts
./scripts/dc.sh logs --no-log-prefix --since 30m app_green | jq -c 'select(.level=="error")'
./scripts/dc.sh exec postgres psql -U relay relay            # SQL shell
cat runtime/state.env; cat runtime/caddy/upstream.caddy      # which color is live
```

---

## 1. 502 Bad Gateway no proxy

**Sintomas.** `curl -i https://DOMAIN/api/health` retorna `502`; o monitor dispara `health`; quem envia
recebe 502 e começa a fazer retry.

**Investigar.**

```bash
cat runtime/caddy/upstream.caddy                    # which app_<color> Caddy proxies to
./scripts/dc.sh ps -a app_blue app_green            # is that color running? healthy? restarting?
./scripts/dc.sh logs --no-log-prefix --since 15m caddy | jq -c 'select(.status==502 or .level=="error") | {ts, msg, error: .error?}'
./scripts/dc.sh exec caddy wget -qO- http://app_blue:3000/api/health   # direct, bypassing the proxy
docker inspect -f '{{.State.OOMKilled}} {{.RestartCount}} {{.State.ExitCode}}' $(docker ps -aqf label=com.docker.compose.service=app_blue)
```

**Causas prováveis.**
- A cor ativa está parada ou em crash loop (env var errada, morta por OOM: `OOMKilled=true`, exit 137).
- O `upstream.caddy` aponta para uma cor que não está rodando (um `dc.sh stop` manual na cor ativa
  ou o arquivo editado à mão).
- O app está de pé, mas `/api/health` falha porque o banco caiu (nesse caso o app responde 503,
  não 502; veja a seção 3).

**Correção.** Se acabou de acontecer um deploy: `./scripts/deploy.sh --rollback`. Se a cor ativa está
parada: `./scripts/dc.sh start app_<color>`. OOM: aumente a memória do servidor ou adicione um
`mem_limit` com folga e procure a requisição que faz a memória disparar. Upstream errado: rode de novo
`./scripts/deploy.sh` com a imagem que está no `state.env`, que reescreve o arquivo de forma consistente;
não edite à mão.

## 2. Fila de entregas parada

**Sintomas.** O ingest responde 202, o dashboard mostra entregas presas em `pending` com
`next_attempt_at` no passado; o monitor dispara `queue` ("overdue ... is the scheduler running?").

**Investigar.**

```bash
./scripts/dc.sh ps -a scheduler
./scripts/dc.sh logs --no-log-prefix --since 30m scheduler      # tick_failed with status=401? 502? timeouts?
./scripts/dc.sh exec postgres psql -U relay relay -c \
  "select status, count(*), min(next_attempt_at) from deliveries group by 1;"
./scripts/dc.sh exec postgres psql -U relay relay -c \
  "select count(*) from deliveries where status='processing' and locked_at < now() - interval '5 minutes';"
```

**Causas prováveis.**
- O container do scheduler está parado (alguém rodou `dc.sh stop scheduler`, ou um restore foi
  interrompido antes de religá-lo).
- `scheduler.tick_failed status=401`: o `CRON_SECRET` está diferente entre o scheduler e o app
  (o `.env` mudou, mas só um dos lados foi recriado).
- `status=502/000`: o scheduler passa pelo listener interno do Caddy, então um problema de proxy/app
  (seção 1) também para a fila.
- Linhas presas em `processing`: um worker morreu no meio de uma tentativa. Elas são recuperadas
  automaticamente depois de 5 minutos (`STALE_LOCK_MS`); muitas delas indicam crashes do app durante a entrega.

**Correção.** Suba ou recrie o scheduler (`./scripts/dc.sh up -d scheduler`). Depois de trocar
secrets, recrie os dois lados: `./scripts/deploy.sh --build <tag>` (app) e
`./scripts/dc.sh up -d scheduler`. Confirme que a contagem de atrasadas cai para 0. As entregas que
esgotaram as tentativas nesse meio-tempo estão na dead-letter queue: reenvie pelo dashboard ou via
`POST /api/v1/events/<id>/replay`.

## 3. Postgres recusando conexões / sem conexões livres

**Sintomas.** `/api/health` retorna 503 `{"ok":false}`; os logs do app mostram `db.init_failed`,
`ECONNREFUSED`, `too many clients already` ou `remaining connection slots are reserved`; o monitor
dispara `database` e `health`.

**Investigar.**

```bash
./scripts/dc.sh ps -a postgres
./scripts/dc.sh logs --since 30m postgres | tail -50          # FATAL, PANIC, "No space left on device"
./scripts/dc.sh exec postgres psql -U relay relay -c \
  "select application_name, state, count(*) from pg_stat_activity group by 1,2 order by 3 desc;"
./scripts/dc.sh exec postgres psql -U relay relay -c \
  "select pid, now()-query_start as age, state, left(query,80) from pg_stat_activity where state <> 'idle' order by 2 desc limit 10;"
```

**Causas prováveis.**
- O Postgres caiu: geralmente disco cheio (seção 4) ou crash depois de um OOM.
- Esgotamento de conexões: cada processo do app abre um pool de até 5 conexões; as duas cores durante um
  deploy, mais as sessões de monitor/backup/psql, precisam caber em `POSTGRES_MAX_CONNECTIONS` (50). Muitas
  linhas `idle in transaction` indicam que algum trecho de código mantém transações abertas.
- Uma query ou lock demorado (`state = active` por minutos, `wait_event_type = Lock`).

**Correção.** Disco: seção 4, depois `./scripts/dc.sh up -d postgres`. Esgotamento: derrube as
conexões problemáticas (`select pg_terminate_backend(pid) ...`) e depois descubra quem as abriu
(`application_name`, `client_addr`) antes de aumentar `POSTGRES_MAX_CONNECTIONS`; aumentar o limite
sem achar a causa só empurra o problema para mais adiante.

## 4. Disco cheio

**Sintomas.** O monitor dispara `disk`; o Postgres registra `No space left on device` e pode parar; os backups
falham (`backup.failed`); o Docker não consegue fazer pull nem build.

**Investigar.**

```bash
df -h /
docker system df                                   # images, build cache, volumes
du -sh deploy/backups; ls -lt deploy/backups | head
sudo du -xh /var/lib/docker --max-depth=2 | sort -h | tail -15
./scripts/dc.sh exec postgres psql -U relay relay -c \
  "select relname, pg_size_pretty(pg_total_relation_size(relid)) from pg_statio_user_tables order by pg_total_relation_size(relid) desc limit 5;"
```

**Causas prováveis.**
- Imagens antigas e build cache de muitos deploys com `--build` (cada release adiciona uma imagem).
- Backups: `BACKUP_KEEP` alto demais para o disco, ou outra coisa gravando em `deploy/backups`.
- Crescimento do banco: `events` guarda todo payload (body bruto + JSON); o sandbox faz limpeza, um
  banco real não.
- Logs fora da rotação do Docker (todos os serviços do compose rotacionam em 10 MB × 5).

**Correção.** `docker image prune -a --filter "until=168h"` e `docker builder prune` (mantém o que os
containers em execução usam); reduza `BACKUP_KEEP` depois de copiar os dumps mais antigos para fora do servidor; no banco,
crie um job de retenção para eventos antigos já entregues e rode `VACUUM (ANALYZE)`. Verifique com `df -h` e
confira se o monitor envia `resolved`.

## 5. Certificado não emitido

**Sintomas.** O navegador mostra erro de certificado ou `ERR_SSL_PROTOCOL_ERROR`; `curl -v
https://DOMAIN` falha no handshake TLS; HTTP funciona ou redireciona.

**Investigar.**

```bash
dig +short DOMAIN                                  # must be this server's public IP
curl -sI http://DOMAIN/ | head -3                  # reachable on :80 from outside? (run from your laptop)
./scripts/dc.sh logs --no-log-prefix --since 1h caddy | jq -c 'select(.logger | test("tls|acme")?) | {ts, level, msg, error: .error?}'
sudo ufw status
echo | openssl s_client -connect DOMAIN:443 -servername DOMAIN 2>/dev/null | openssl x509 -noout -issuer -dates
```

**Causas prováveis.**
- O DNS ainda não aponta para o servidor (ou um registro `AAAA` antigo aponta para outro lugar: o Let's Encrypt
  dá preferência ao IPv6 quando ele existe).
- Porta 80 ou 443 bloqueada (ufw, firewall/security group do provedor de cloud): os desafios HTTP-01 e
  TLS-ALPN precisam delas.
- Rate limit depois de muitas tentativas com falha (`too many failed authorizations`, `rateLimited`).
- `CADDY_TLS=internal` esquecido dos testes: o certificado vem da "Caddy Local Authority".
- O volume `caddy_data` foi apagado: os certificados são reemitidos no boot (e contam para o rate
  limit).

**Correção.** Corrija o DNS ou o firewall, depois rode `./scripts/dc.sh restart caddy` e acompanhe os logs até aparecer
`certificate obtained successfully`. Em caso de rate limit, espere (o Caddy também recorre à ZeroSSL) e
nunca apague o `caddy_data` como "correção".

## 6. Deploy que nunca fica healthy

**Sintomas.** O `deploy.sh` termina com `ROLLBACK: app_<color> exited during startup` /
`... is unhealthy` / `not healthy after 120s`. Os usuários não são afetados: o proxy não foi trocado.

**Investigar.** O `deploy.sh` imprime as últimas 40 linhas de log do container que falhou. Para mais detalhes:

```bash
./scripts/dc.sh logs --no-log-prefix app_green | tail -100
docker inspect -f '{{json .State.Health}}' $(docker ps -aqf label=com.docker.compose.service=app_green) | jq
./scripts/dc.sh run --rm -T migrate                # do migrations apply cleanly?
./scripts/dc.sh config | grep -A12 'app_green:'    # the env the container actually received
```

**Causas prováveis.**
- A nova release quebra no boot (env var faltando, erro de código no import): o log mostra um
  stack trace e exit code 1.
- O health check falha porque o app não consegue alcançar o Postgres com a nova configuração (503 no
  log de health).
- A máquina é pequena demais para subir uma segunda instância ao lado da ativa (OOM durante a inicialização,
  exit 137), ou a inicialização demora mais que `HEALTH_TIMEOUT_SECONDS`.
- A etapa de migração falhou: o script parou antes de subir a nova cor.

**Correção.** Corrija a release e faça o deploy de novo; enquanto isso, a cor ativa continua atendendo. Para
inicialização lenta, aumente `HEALTH_TIMEOUT_SECONDS`; para memória, adicione RAM ou swap em vez de abrir mão do
blue-green. O CI roda exatamente esse cenário (uma release que quebra no boot) em todo PR.
