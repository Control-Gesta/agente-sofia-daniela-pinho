# Sofia — agente de IA da Clínica Dra. Daniela Pinho (Kommo)

SDR de IA respondendo WhatsApp com o **Kommo** como CRM, **sem n8n**: OpenAI + Vercel (serverless) + Upstash Redis.

**Onde está no ar (02/09/2026):**

| | |
|---|---|
| URL de produção | `https://agente-sofia-daniela-pinho-pi.vercel.app` |
| Projeto Vercel | `control-gestao/agente-sofia-daniela-pinho` (conta `tecnico-2108`) |
| Conta Kommo | `dradanielapinho.kommo.com` (account_id 29922050) |
| Webhook ativo | 1 só, `add_message` → `/api/inbound` da URL acima |

> Migrado em 02/09/2026 da conta Vercel antiga (`vertisell`), onde o projeto de mesmo nome
> ficou inerte (sem webhook apontando pra ele) e pausado via `AGENTE_PAUSADO=1`. O vínculo
> antigo está guardado em `.vercel/project.json.vertisell-backup` caso precise de rollback.

O que ele faz: conversa com memória, junta mensagens em rajada (buffer), qualifica e preenche campos no card, move o lead de etapa, entende áudio do paciente (STT), e só age em quem tem a tag de liberação.

**Desvios do template padrão do curso — leia antes de mexer:**

1. **Cérebro em OpenAI (GPT-5.4 Mini), não Claude.** O template do curso é validado com Claude Sonnet 5; aqui foi trocado por decisão da cliente (só tinha chave OpenAI). Ver `lib/llm.ts` — reescrito do zero pro formato de tool-calling da OpenAI, sem o histórico de evals que o Claude tem no curso. Se algo se comportar estranho na conversa (ignorar uma tool, alucinar), esse é o primeiro suspeito.
2. **Sem agendamento.** A Sofia NUNCA marca consulta, não mexe em calendário, não confirma Pix — isso é sempre do time humano. Não existe tool `marcar_reuniao`, nem campo "Data da reunião". A alçada dela termina na etapa "Lead para Agendar" + `escalar_para_humano`.
3. **Sem follow-up automático (por enquanto).** O motor de cadências (`lib/followup.ts`, `api/followup.ts`) está no código mas DORMENTE: sem cron no `vercel.json` e sem `CRON_SECRET`, ele nunca dispara sozinho. Fica pronto pra ligar quando a clínica quiser (ver seção própria abaixo).
4. **Sem voz de saída.** Desenho A (Salesbot) não suporta voice note, e o guia da clínica proíbe a Sofia de mandar áudio mesmo quando o paciente manda. Ela recebe e transcreve áudio, mas responde sempre em texto.

## Por que o Kommo é diferente (leia antes de mexer)

| | CRM que devolve transcript | Kommo (este projeto) |
|---|---|---|
| Histórico da conversa | API do CRM é a fonte de verdade | **Redis** (`ak:conv:{leadId}`) — o Kommo **não** devolve o transcript |
| Envio de mensagem | endpoint direto de mensagem | **indireto**: Salesbot (só Desenho A neste projeto) |
| Entrada | workflow do CRM → webhook | webhook nativo `add_message` |
| Voz (voice note) | upload + attachment | não usada neste projeto (ver acima) |
| Agendamento | agenda nativa | não usado neste projeto (ver acima) |
| Entidade das tools | contato + oportunidade | **lead** (Kommo é lead-cêntrico) |

```
Kommo webhook add_message → /api/inbound (responde 200 na hora + waitUntil)
  → dedup + STT + histórico no Redis → buffer 10s (eleição) → OpenAI + tools
  → grava campo "Resposta IA (agente)" + outbox no Redis → POST /api/v2/salesbot/run
  → Salesbot: widget-request /api/salesbot → return_url {resposta_ia} → envia
```

## Arquivos

| Arquivo | O que é |
|---|---|
| `prompt.md` | System prompt da Sofia — persona, tom, fluxo, tabela de preços, limites |
| `lib/crm-map.ts` | **IDs do Kommo da conta da clínica** (funil, etapas, campos) — a única coisa que muda por cliente |
| `lib/config.ts` | Leitura das env vars (o que é obrigatório e o que é opcional) |
| `lib/kommo.ts` | Client da API v4 + salesbot/run (retry, merge de tags) |
| `lib/redis.ts` | Conexão do Upstash (todas as chaves usam o prefixo `ak:`) |
| `lib/history.ts` | Histórico no Redis + dedup + anti-eco |
| `lib/buffer.ts` | Debounce/eleição: rajada de mensagens vira 1 resposta só |
| `lib/llm.ts` | Chamada do modelo (OpenAI) + loop de tools — **não é o `lib/claude.ts` do template padrão** |
| `lib/tools.ts` | As tools do CRM (todas leem o `crm-map.ts`) — sem `marcar_reuniao` |
| `lib/transport.ts` | Envio via Salesbot |
| `lib/stt.ts` | Ouvido (transcrição via OpenAI, não Groq) |
| `lib/followup.ts` | Motor de cadências no Redis — dormente (ver acima) |
| `lib/agent.ts` | Core: gate por tag → buffer → OpenAI → envio → followup |
| `api/inbound.ts` | Webhook `add_message` do Kommo |
| `api/salesbot.ts` | Callback do widget-request do bot de envio |
| `api/followup.ts` | Endpoint de cadências — sem cron ligado, só roda se chamado manualmente com `force=1` |
| `api/validate.ts` | Confere a coerência do `crm-map.ts` e compara com o Kommo vivo (rodar após QUALQUER mexida no funil) |

Depuração é pelo **log nativo da Vercel** (`vercel logs` ou o painel do projeto). Todo caminho importante do código já loga com prefixo (`[agente]`, `[inbound]`, `[llm]`, `[stt]`, `[transport]`).

## Passo a passo

### 1. Preparar a conta Kommo

No funil que a Sofia vai atender, confira/crie:

- **Etapas**: Novo Lead → Interesse 30 dias → Lead para Agendar (nomes exatos — ajuste `lib/crm-map.ts` se a clínica preferir outros)
- **Campos do LEAD**: "Procedimento de interesse" (textarea) e "Resumo da conversa" (textarea)
- Campo **textarea `Resposta IA (agente)`** — onde o agente deposita a resposta antes do Salesbot enviar
- Tags de controle: liberação (`sofia-ativa`) e parada (`atendimento-humano`)

> Os nomes `Resposta IA (agente)` e os das etapas em `crm-map.ts` são comparados literalmente pelo `/api/validate`. Mudou o nome no Kommo? Ajuste o mapa (ou o `api/validate.ts`).

Token de longa duração: Configurações → Integrações → criar integração.

### 2. Preencher o `lib/crm-map.ts`

Os IDs no arquivo são placeholder (`0`; no `stageOrder`, `-1`, `-2`, … — precisam ser diferentes entre si, o guard anti-retrocesso é um `indexOf` nesse array). Descoberta ao vivo:

```bash
curl -H "Authorization: Bearer $KOMMO_TOKEN" "$KOMMO_DOMAIN/api/v4/leads/pipelines"
curl -H "Authorization: Bearer $KOMMO_TOKEN" "$KOMMO_DOMAIN/api/v4/leads/custom_fields?limit=250"
```

Copie os `id` dos statuses e dos campos. `stageOrder` precisa listar **todos** os status do funil (inclusive os que a Sofia não usa, como "Consulta Confirmada/Aguardando Pix") — status faltando = guard furado.

O `/api/validate` denuncia isso antes de virar perda silenciosa de dado.

### 3. Deploy

```bash
npm install
npx tsc --noEmit          # tem que passar limpo antes de subir
vercel link               # escolha/crie o projeto
# configure as env vars do .env.local no painel da Vercel
vercel deploy --prod --yes
# sanity check:
curl "https://<seu-deploy>/api/validate?secret=SEU_WEBHOOK_SECRET"   # → {"ok": true}
```

### 4. Webhook de entrada

```bash
python scripts/create_webhook.py "https://<seu-deploy>/api/inbound?secret=<WEBHOOK_SECRET>"
```

### 5. Salesbot de ENVIO (~3 min na UI do Kommo)

O agente dispara `POST /api/v2/salesbot/run {bot_id, entity_id, entity_type: "leads"}` e o bot entrega a mensagem.

**Opção 1 — widget-request:** bot com um bloco de request apontando para `https://<seu-deploy>/api/salesbot?secret=<WEBHOOK_SECRET>`; o passo seguinte envia `{{json.resposta_ia}}`.

**Opção 2 — campo do lead (sem widget):** bot com um único bloco "Enviar mensagem" cujo conteúdo é o campo **"Resposta IA (agente)"**.

Anote o ID do bot e coloque em `KOMMO_BOT_ID` (`.env.local` **e** painel da Vercel — redeploy depois).

> ⚠️ O webhook `add_message` é da **conta inteira**. Se a clínica já tem outro bot/automação respondendo o mesmo público, o paciente recebe resposta duplicada.

## Ligar/desligar a Sofia por lead

- **Ligar**: tag `sofia-ativa` no lead (`GATE_TAG`). Vazio = responde todos (não recomendado antes da rampagem).
- **Desligar**: tag `atendimento-humano` (a tool `escalar_para_humano` faz isso sozinha).

Rampagem: 1 lead seu → 3-5 leads reais acompanhados de perto → um dia inteiro → gate aberto.

## Se um dia quiserem ligar o follow-up automático

1. Criar no Kommo o campo select "Follow-up" (4 opções: Follow-up 1..4) e anotar os `enum_id`.
2. Preencher `crm-map.ts` → `followup.campoCadencia.id` e os `enum_id`.
3. Configurar `CRON_SECRET` no `.env.local` e no painel da Vercel.
4. Devolver o bloco `crons` no `vercel.json`: `{ "path": "/api/followup", "schedule": "0 12 * * *" }`.
5. Redeploy e testar com `curl ".../api/followup?secret=...&force=1"`.

⚠️ Lembrete importante: com WhatsApp OFICIAL (Salesbot), mensagem livre fora da janela de 24h da Meta não entrega. Só a 1ª cadência (12h) entra na janela — as demais precisariam de template WABA aprovado.

## Teste E2E

```bash
curl https://<seu-deploy>/api/inbound
curl "https://<seu-deploy>/api/validate?secret=XXX"
python scripts/simulate_inbound.py <LEAD_ID> "quero saber sobre botox"
```

Checklist: texto simples → rajada de 3 msgs (tem que sair **1 resposta só**) → áudio (transcreveu?) → qualificação preencheu "Procedimento de interesse" → moveu etapa conforme a conversa evolui → concordou com a política comercial → escalou pro humano com a tag certa.

## Pegadinhas do Kommo (cicatrizes de produção)

1. **PATCH de tags SUBSTITUI o conjunto inteiro** — sempre use `addLeadTags`/`removeLeadTags` (merge local).
2. **select/multiselect gravam por `enum_id`**, não por texto — por isso o mapa carrega os enum_ids.
3. **A conta muda no mesmo dia** — o time renomeia status/campo sem avisar. Rode `/api/validate` depois de qualquer mexida no funil.
4. **curl no Git Bash do Windows corrompe UTF-8** no body JSON — use Python ou Node pra mandar acentuação, ou crie campos pela UI.
5. **Salesbot = 1 mensagem por resposta** (as partes viram parágrafos na mesma msg).
