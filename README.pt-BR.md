# Webhook Relay

[English](README.md) · [Português](README.pt-BR.md)

Um gateway de webhooks para plataformas de pagamento e vendas. Ele verifica assinaturas, deduplica eventos, refaz entregas que falharam com backoff exponencial, mantém um log de auditoria pesquisável e permite reenviar qualquer coisa a partir de uma fila de dead-letter. É um app Next.js com dashboard e uma pequena API de gestão.

[![CI](https://github.com/trichains/webhook-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/trichains/webhook-relay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Demo](https://img.shields.io/badge/demo-live-f2884b.svg)](https://webhook-relay-gray.vercel.app)

![banner](docs/banner.png)

## Por quê

Plataformas como Hotmart, processadores de pagamento no estilo Stripe e CRMs avisam seus sistemas sobre vendas por webhook. Tratar isso direto dentro de cada app costuma dar errado sempre dos mesmos jeitos:

- **Requisições forjadas.** Sem checar a assinatura, qualquer um que descubra a URL consegue "aprovar" uma compra.
- **Duplicatas.** Quem envia refaz o envio em caso de timeout, então o mesmo `PURCHASE_APPROVED` pode chegar duas ou três vezes. Sem idempotência você libera acesso duas vezes, manda dois e-mails ou conta a receita em dobro.
- **Sistemas fora do ar.** Se a área de membros ou o ERP cai por dez minutos, os eventos enviados nesse intervalo se perdem, a não ser que algo continue tentando.
- **Nenhum rastro.** Quando o cliente diz "paguei e não recebi nada", você precisa ver exatamente o que chegou, quando, e o que o seu receptor respondeu.

O Webhook Relay fica entre a plataforma e os seus apps e resolve esses quatro problemas num lugar só. Seus apps recebem um fluxo verificado e deduplicado com o header `Idempotency-Key`, e você ganha um dashboard para ver e reenviar o que aconteceu.

## O que ele faz

- **Sources (entrada).** Cada source tem uma URL de ingest `POST /api/ingest/<slug>` e um secret gerado no servidor e exibido uma única vez. Esquemas de assinatura:
  - `hmac-sha256`: `X-Signature: t=<unix>,v1=<HMAC em hex de "<t>.<corpo bruto>">`, tolerância de 5 minutos no timestamp, comparação em tempo constante.
  - `hotmart-hottok`: token estático em `X-HOTMART-HOTTOK` (ou `?hottok=` para a Hotmart v1), comparação em tempo constante.
  - `none`: aceita qualquer coisa; aparece marcado em vermelho na UI e não está disponível no sandbox público.
- **Rotação de secret com período de carência.** Ao rotacionar um secret, o anterior continua válido por 24 horas, para dar tempo de atualizar quem envia sem perder eventos. A UI mostra até quando o secret antigo é aceito e permite revogá-lo antes; eventos verificados com ele aparecem identificados.
- **Ingestão.** Lê o corpo bruto (limite de 1 MB), verifica, faz o parse do JSON, deriva a chave de idempotência (header `Idempotency-Key`, senão o `id` do payload, senão `sha256(source + corpo)`), extrai o tipo do evento de um caminho JSON configurável (`event` por padrão), grava o evento e responde `202`. Duplicatas recebem `200 {"duplicate": true}` e não são entregues de novo. Requisições que falham na verificação recebem `401` e ficam gravadas para auditoria, mas nunca são entregues.
- **Destinations (saída).** Por source: URL, filtro de eventos opcional (tipos separados por vírgula), ativo/pausado, máximo de tentativas (padrão 6) e timeout HTTP. O payload original é repassado byte a byte com os headers `Idempotency-Key`, `X-Relay-Event-Id`, `X-Relay-Delivery-Id`, `X-Relay-Attempt` e `X-Relay-Event-Type`.
- **Sinks de demonstração embutidos**, para a demo funcionar sem URLs externas: `/api/sink/ok` (200), `/api/sink/fail` (500), `/api/sink/flaky` (503 em mais ou menos metade das vezes), `/api/sink/slow` (200 depois de 3 s), `/api/sink/reject` (400).
- **Motor de entrega.** A primeira tentativa roda logo depois do `202`, com `after()` de `next/server`. Cada tentativa registra status code, latência, os primeiros 500 caracteres da resposta e o erro. Falhas são refeitas com backoff exponencial e jitter; depois do máximo de tentativas, ou num 4xx permanente ou num redirect (redirects nunca são seguidos), a entrega vai para a fila de dead-letter.
- **Política de URLs de saída.** No sandbox só os sinks embutidos são permitidos, com checagem ao salvar a destination e de novo logo antes de cada tentativa. Com banco de verdade, URLs externas são permitidas, mas hosts em faixas privadas, de loopback, link-local, CGNAT e outras reservadas são recusados, tanto como host literal (incluindo IPv6 com IPv4 mapeado, `::`, nomes com ponto no final e IPv4 em decimal/hex) quanto depois de resolver o hostname, antes de cada tentativa.
- **Worker da fila.** `GET /api/cron/deliver` (Vercel Cron, protegido por `CRON_SECRET`) e um botão "Process queue now". Pode rodar em paralelo com segurança: no Postgres as linhas são reservadas com `FOR UPDATE SKIP LOCKED`.
- **Replay.** Reenvia um evento para uma destination (ou para todas as que batem com o filtro), ou devolve para a fila todos os dead letters de uma destination.
- **Dashboard** (`/dashboard`): visão das últimas 24h (eventos, taxa de sucesso das entregas, dead letters, latência p50/p95, volume por hora), tabela de eventos com filtros (source, status, tipo de evento, busca pela chave de idempotência), detalhe do evento (headers, JSON formatado com botão de copiar, resultado da verificação, linha do tempo das tentativas por destination), saúde das destinations, fila de dead-letter e CRUD de sources/destinations com Server Actions e validação com zod.
- **Send test webhook.** Assina um exemplo realista (payload no estilo Hotmart v2 de `PURCHASE_APPROVED` para sources com hottok, e um `order.paid` genérico nos demais casos) com o próprio secret da source, passa pelo pipeline de ingest e leva até o evento criado.
- **API de gestão** em `/api/v1` (veja abaixo).
- **Modo sandbox.** Sem `DATABASE_URL`, um banco PGlite em memória recebe as migrations e o seed no boot: 2 sources, 4 destinations apontando para os sinks de demo e 60 eventos nas últimas 48 horas com resultados variados. A primeira requisição depois de um cold start leva uns 3 s localmente (boot do Postgres em WASM, migrations e seed), e mais na Vercel.

## Arquitetura

```mermaid
sequenceDiagram
    autonumber
    participant P as Platform (Hotmart, checkout, CRM)
    participant I as POST /api/ingest/[slug]
    participant DB as Postgres / PGlite
    participant W as Delivery engine
    participant D as Destination
    participant U as Dashboard / API

    P->>I: webhook (raw body + signature)
    I->>I: verify HMAC or hottok (constant time)
    alt invalid signature
        I->>DB: store as rejected (audit only)
        I-->>P: 401
    else valid
        I->>I: parse JSON, derive idempotency key, event type
        I->>DB: insert event (unique per source + key)
        alt duplicate key
            I-->>P: 200 {duplicate: true}
        else new event
            I->>DB: one delivery row per matching active destination
            I-->>P: 202 accepted
            Note over I,W: after(): first attempt runs once the response is sent
            W->>DB: claim delivery (status pending → processing)
            W->>W: check URL policy (sinks only in sandbox, resolved IP not private)
            W->>D: POST original payload + Idempotency-Key
            alt 2xx
                W->>DB: attempt ok, delivery succeeded
            else error, timeout or 5xx/408/429
                W->>DB: attempt failed, next_attempt_at = now + backoff
                loop cron (daily on Hobby, every minute on Pro) / "Process queue now"
                    W->>DB: claim due rows (FOR UPDATE SKIP LOCKED)
                    W->>D: retry
                end
                W->>DB: max attempts reached (or permanent 4xx / 3xx) → dead_letter
            end
        end
    end
    U->>DB: replay event / retry all dead letters → pending
    U->>W: attempt again (same attempt timeline, trigger = replay)
```

**O fluxo em palavras.** A rota de ingest faz só o mínimo necessário para dizer "recebi" com segurança: verifica, deduplica, grava e enfileira. Tudo o que é lento (chamar os seus receptores) acontece depois da resposta, então uma destination lenta nunca faz a plataforma estourar o timeout e reenviar. As entregas são linhas no Postgres com um status e um `next_attempt_at`, o que deixa a fila inspecionável com SQL puro e permite que vários workers a compartilhem.

**Agenda de retries** (`base 30s × 4^(n-1)`, teto de 6h, jitter de ±20%):

| Tentativa que falhou | Espera em produção | Acumulado (sem jitter) | Espera no sandbox |
| -------------------- | ------------------ | ---------------------- | ----------------- |
| 1                    | 30s                | 30s                    | 2s                |
| 2                    | 2m                 | 2m 30s                 | 4s                |
| 3                    | 8m                 | 10m 30s                | 8s                |
| 4                    | 32m                | 42m 30s                | 16s               |
| 5                    | 2h 8m              | 2h 50m 30s             | 32s               |
| 6 (máximo padrão)    | → dead letter      |                        | → dead letter     |
| 7+ (máximo 12)       | 6h (teto)          |                        | 60s (teto)        |

O modo sandbox comprime a agenda para segundos (base 2s, fator 2, teto 60s), para dar para ver uma entrega sair de "retrying" e virar dead letter em menos de um minuto. Respostas 4xx diferentes de 408, 425 e 429 são tratadas como permanentes e vão direto para dead-letter: o receptor entendeu a requisição e recusou, então mandar os mesmos bytes de novo não vai adiantar. Respostas 3xx também são permanentes (`redirect not followed`), porque seguir um redirect poderia mandar o payload para um lugar que a política nunca checou.

As esperas acima são o momento mais cedo em que um retry pode acontecer; o momento real depende de com que frequência o worker roda. O `vercel.json` vem com agenda diária (`0 0 * * *`) porque a Vercel Hobby recusa crons mais frequentes. Na Vercel Pro, use `* * * * *` para os retries seguirem a tabela de perto.

**Estrutura de pastas**

```
app/
  api/ingest/[sourceSlug]/   inbound webhooks
  api/sink/[kind]/           built-in demo receivers
  api/cron/deliver/          queue worker (Vercel Cron)
  api/v1/events/             management API
  api/health/                liveness + driver
  dashboard/                 overview, events, sources, destinations, dead letters
    actions.ts               Server Actions (zod-validated)
  opengraph-image.tsx        generated Open Graph image
lib/
  db/schema.ts, client.ts    Drizzle schema, pg / PGlite handle (globalThis singleton)
  db/seed.ts                 deterministic sandbox fixture
  services/ingest.ts         verify → dedupe → store → enqueue
  services/delivery.ts       claim, attempt, backoff, dead-letter, queue pass
  services/replay.ts         replay and retry-all
  services/sources.ts        secret rotation, sandbox limits, event cap
  ssrf.ts                    outbound URL policy (literal + resolved IP checks)
  signing.ts, idempotency.ts, event-type.ts, backoff.ts, stats.ts
drizzle/                     generated SQL migrations
tests/unit, tests/integration, e2e/
proxy.ts                     Basic auth for /dashboard (fails closed with a real database and no token)
```

## Decisões e trade-offs

- **Postgres como fila.** Nada de Redis ou SQS: as entregas são linhas, reservadas com `UPDATE … WHERE id IN (SELECT … FOR UPDATE OF deliveries SKIP LOCKED)`. O cron, o botão "process now" e o `after()` podem rodar ao mesmo tempo sem enviar em dobro. Uma linha presa em `processing` por mais de 5 minutos (worker que caiu) é retomada, e o timestamp do lock funciona como token de posse: a escrita final só vale se a linha ainda estiver em `processing` com o mesmo `locked_at`, então um worker lento cuja linha foi retomada não consegue sobrescrever o resultado. No PGlite (conexão única) a reserva é uma simples transição de status. O throughput dá conta de volumes de webhook; um cenário de alto volume pediria uma fila dedicada.
- **At-least-once, com a chave repassada adiante.** Uma queda entre a chamada HTTP e a escrita no banco pode reenviar uma tentativa, por isso toda requisição de saída leva `Idempotency-Key`. Exactly-once não existe atravessando uma fronteira HTTP; esta é a versão honesta.
- **Ordem da chave de idempotência: header → `id` do payload → hash do corpo.** A Hotmart coloca um `id` único em cada evento, então reenvios do mesmo evento são deduplicados mesmo quando o timestamp da assinatura muda. O hash do corpo é o plano B para quem não manda nada. O índice único é parcial (`WHERE verified`), então uma requisição forjada nunca "queima" a chave de um evento real.
- **Requisições rejeitadas são guardadas, não entregues.** Ajuda a depurar quem envia com configuração errada (secret errado, relógio fora de sincronia). Os corpos guardados são truncados em 16 KB e secrets nos headers são mascarados.
- **Drizzle + um schema, dois drivers.** `pg` quando `DATABASE_URL` está definido, PGlite (Postgres compilado para WASM) nos outros casos. Mesmo SQL, mesmas migrations. Os testes de integração rodam no PGlite por padrão (sem precisar de Docker), e o CI roda a mesma suíte contra um serviço `postgres:16`, para o caminho do `SKIP LOCKED` ser exercitado de verdade.
- **Uma demo pública que não dá para abusar.** No sandbox, as destinations só podem apontar para os sinks embutidos, o esquema `none` fica desabilitado, as sources de demo do seed são somente leitura (sem excluir, sem rotacionar secret, e as destinations delas não podem ser excluídas), os eventos têm limite de 2.000 (os mais antigos saem, rejeitados inclusive) e há limites de 25 sources e 10 destinations por source.
- **URL base configurada antes do header Host.** URLs de ingest, resolução dos sinks e o "send test webhook" usam `NEXT_PUBLIC_APP_URL`, depois o domínio de produção da Vercel (`VERCEL_PROJECT_PRODUCTION_URL`), e só então a origem da requisição, já que o header Host é controlado pelo cliente.
- **Detalhes do sandbox em serverless.** A instância do PGlite fica em `globalThis` para sobreviver entre requisições numa instância quente. No sandbox, o "Send test webhook" chama o pipeline de ingest dentro do próprio processo (uma chamada HTTP poderia cair em outra instância, com outro banco em memória); com banco de verdade é um POST HTTP real para a URL de ingest. Pelo mesmo motivo, no sandbox as visualizações de página do dashboard também processam um pedaço da fila.
- **Replays resetam a entrega no lugar.** O ciclo de tentativas volta a zero e o `replay_count` aumenta, então o histórico completo (tentativas que falharam, depois o replay) fica numa linha do tempo só, em vez de espalhado em cópias.
- **Secrets guardados em texto puro.** A verificação HMAC precisa do secret original, então não dá para guardar só o hash. A UI mostra o secret uma vez, na criação ou na rotação. Criptografar em repouso está no roadmap.

## Stack

Next.js 16 (App Router, Server Actions, `after()`, `proxy.ts`), React 19, TypeScript (strict), Tailwind CSS v4, Drizzle ORM, `pg` / `@electric-sql/pglite`, zod 4, Vitest, Playwright.

## Rodando localmente

Pré-requisitos: Node 22+ e npm.

```bash
npm install
cp .env.example .env.local   # optional, everything works with it empty
npm run dev                  # http://localhost:3101
```

Sem `DATABASE_URL`, o app sobe em modo sandbox. Para usar Postgres:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/webhook_relay npm run db:migrate
DATABASE_URL=... RELAY_ADMIN_TOKEN=$(openssl rand -hex 32) npm run dev
```

| Variável              | Para que serve                                                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`        | Connection string do Postgres. Vazio = sandbox (PGlite em memória, com seed, reseta ao reiniciar).                                                                                                   |
| `RELAY_ADMIN_TOKEN`   | Bearer token para `/api/v1/*` e senha do Basic auth em `/dashboard`. Obrigatório com banco de verdade: sem ele a API e o dashboard respondem 503 (fail closed).                                      |
| `CRON_SECRET`         | A Vercel Cron envia como bearer token para `/api/cron/deliver`. Vazio = endpoint aberto.                                                                                                             |
| `NEXT_PUBLIC_APP_URL` | URL pública. Tem prioridade sobre o header Host da requisição para URLs de ingest, resolução dos sinks embutidos, test webhooks e metadados Open Graph (fallback: `VERCEL_PROJECT_PRODUCTION_URL`). |

Enviando um webhook assinado na mão (source HMAC):

```bash
BODY='{"id":"evt_123","event":"order.paid"}'
TS=$(date +%s)
SIG=$(printf '%s' "$TS.$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -X POST http://localhost:3101/api/ingest/<your-source-slug> \
  -H 'content-type: application/json' -H "x-signature: t=$TS,v1=$SIG" -d "$BODY"
```

As sources de demo do seed recebem secrets aleatórios no boot e são somente leitura no sandbox; crie a sua própria source em `/dashboard/sources` para ter um secret que dá para copiar.

Testes:

```bash
npm run lint
npm run typecheck
npm test             # unit + integration on PGlite (no Docker needed)
DATABASE_URL=postgres://... npm test   # same suite against a real (disposable!) Postgres; it truncates the tables
npx playwright install chromium
npm run test:e2e     # starts or reuses the dev server on :3101
```

### API de gestão

Todos os endpoints de `/api/v1` exigem `Authorization: Bearer $RELAY_ADMIN_TOKEN` quando o token está definido. No modo sandbox sem token eles ficam abertos e as respostas trazem `x-relay-auth: open-sandbox`.

| Método | Caminho                      | Descrição                                                                                                                                                                                                                                  |
| ------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/api/v1/events`             | Lista eventos. Query: `source` (id), `status` (`pending`, `delivered`, `dead_letter`, `rejected`, `no_destinations`), `type`, `q` (chave de idempotência contém), `page`, `page_size` (máx. 200). Retorna `{ data, page, pageSize, total }`. |
| `GET`  | `/api/v1/events/{id}`        | Evento com headers, payload, resultado da verificação e todas as entregas com suas tentativas.                                                                                                                                             |
| `POST` | `/api/v1/events/{id}/replay` | Corpo `{ "destinationId"?: string }`. Reenfileira o evento (uma destination, ou todas as que batem) e já tenta entregar. `202 { queued, deliveryIds }`. `409` para eventos rejeitados.                                                     |
| `POST` | `/api/ingest/{slug}`         | Endpoint de ingest. `202` aceito, `200` duplicata, `401` assinatura inválida, `400` JSON inválido, `404` source desconhecida, `413` acima de 1 MB.                                                                                          |
| `GET`  | `/api/cron/deliver`          | Uma passada na fila (até 50 entregas vencidas). Bearer `CRON_SECRET` quando definido.                                                                                                                                                      |
| `GET`  | `/api/health`                | `{ ok, driver }`.                                                                                                                                                                                                                          |

## Demo e limitações

- A demo pública roda em modo sandbox: os dados ficam em memória e resetam a cada cold start. Instâncias serverless diferentes podem mostrar dados diferentes.
- Não há contas de usuário. Com `RELAY_ADMIN_TOKEN` definido, o dashboard fica atrás de HTTP Basic auth; no sandbox (sem token, sem banco) ele fica aberto, com as restrições listadas em decisões e trade-offs.
- Com o cron diário padrão, retries que não são disparados pelo `after()`, pelo "Process queue now" ou (no sandbox) pelas visualizações do dashboard esperam a próxima execução diária. Use `* * * * *` na Vercel Pro.
- A checagem de endereço privado resolve o hostname antes de cada tentativa, mas o `fetch` resolve de novo ao conectar. Uma resposta de DNS que muda entre as duas consultas (rebinding com TTL muito curto) não fica totalmente coberta; fixar a conexão no IP checado está no roadmap.
- Os percentis de latência são calculados no app sobre as 10.000 tentativas mais recentes da janela, o que serve nessa escala mas não para milhões de linhas.
- As requisições de saída ainda não são assinadas, então os receptores não conseguem verificar que vieram do relay (além de controles de rede).

## Roadmap

- Assinar as entregas de saída (HMAC por destination) para os receptores verificarem o relay.
- Fixar as conexões de saída no IP que passou na checagem de endereço privado.
- Criptografar os secrets das sources em repouso.
- Transformações de payload por destination (mapeamento de campos, por exemplo Hotmart → formato do CRM).
- Retenção configurável de eventos e tentativas com banco de verdade, e percentis calculados em SQL.
- Rate limit por destination e um circuit breaker que pausa a destination depois de falhas seguidas.

## Licença

[MIT](LICENSE) © 2026 Cristhian Almeida
