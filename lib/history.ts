import { redis } from './redis'

/**
 * Histórico da conversa — o Kommo NÃO devolve transcript de chat pela API
 * pública, então o agente é o dono do histórico (aqui, no Redis).
 *
 * - Lista `ak:conv:{leadId}`: últimas 40 mensagens, TTL 90 dias.
 *   TTL é feature: custo zero crescente + LGPD (o dado bruto morre; o que
 *   importa comercialmente é eternizado no CRM via "Resumo da conversa").
 * - Mensagem de atendente humano digitada DENTRO do Kommo só entra quando o
 *   webhook manda a direção (`message[add][0][type]`) — e ele nem sempre
 *   manda (limitação do Desenho A). É aceitável: humano que assume ganha a
 *   tag que desliga o agente.
 *   No Desenho B (uazapi) TUDO entra, inclusive fromMe.
 */

export interface ChatMsg {
  /** id da mensagem na origem (webhook Kommo / uazapi) ou uuid gerado */
  id: string
  dir: 'in' | 'out'
  text: string
  /** epoch ms */
  ts: number
}

const MAX_MSGS = 40
const TTL_S = 90 * 86400

const convKey = (leadId: number) => `ak:conv:${leadId}`

export async function appendMessage(leadId: number, msg: ChatMsg): Promise<void> {
  const key = convKey(leadId)
  await redis.rpush(key, JSON.stringify(msg))
  await redis.ltrim(key, -MAX_MSGS, -1)
  await redis.expire(key, TTL_S)
}

export async function getHistory(leadId: number): Promise<ChatMsg[]> {
  const raw = await redis.lrange<string | ChatMsg>(convKey(leadId), 0, -1)
  const out: ChatMsg[] = []
  for (const r of raw) {
    try {
      out.push(typeof r === 'string' ? (JSON.parse(r) as ChatMsg) : r)
    } catch { /* entrada corrompida: ignora */ }
  }
  return out
}

/**
 * Apaga a conversa de um lead. NÃO é usada pelo pipeline — está aqui pra
 * quando você quiser zerar um lead de teste e repetir o E2E do começo
 * (chame de um script seu). Se não for usar, pode apagar sem quebrar nada.
 */
export async function clearHistory(leadId: number): Promise<void> {
  await redis.del(convKey(leadId))
}

export function lastInbound(msgs: ChatMsg[]): ChatMsg | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].dir === 'in') return msgs[i]
  }
  return null
}

/** true se a última msg é do lead (ninguém respondeu ainda). */
export function lastIsInbound(msgs: ChatMsg[]): boolean {
  if (msgs.length === 0) return false
  return msgs[msgs.length - 1].dir === 'in'
}

// ---------- Canal da conversa (transport dinâmico) ----------
// O lead responde pelo canal onde ELE fala: mensagem entrou pelo webhook do
// Kommo → resposta via Salesbot; entrou pela uazapi → resposta via uazapi
// (com voz). O followup usa o último canal registrado.

export type Channel = 'kommo' | 'uazapi'

export async function setChannel(leadId: number, via: Channel): Promise<void> {
  await redis.set(`ak:via:${leadId}`, via, { ex: 60 * 86400 })
}

export async function getChannel(leadId: number): Promise<Channel | null> {
  const v = await redis.get<string>(`ak:via:${leadId}`)
  return v === 'uazapi' || v === 'kommo' ? v : null
}

// ---------- Dedup / idempotência ----------

/** true se esta mensagem JÁ foi registrada (retry de webhook) — atômico via SET NX. */
export async function seenMessage(msgId: string): Promise<boolean> {
  if (!msgId) return false
  const set = await redis.set(`ak:seen:${msgId}`, '1', { nx: true, ex: 7 * 86400 })
  return set !== 'OK'
}

/** Idempotência de resposta: id da última inbound já respondida. */
export async function alreadyAnswered(leadId: number, inboundMsgId: string): Promise<boolean> {
  const done = await redis.get<string>(`ak:done:${leadId}`)
  return done === inboundMsgId
}

export async function markAnswered(leadId: number, inboundMsgId: string): Promise<void> {
  await redis.set(`ak:done:${leadId}`, inboundMsgId, { ex: 86400 })
}

// ---------- Anti-eco (Desenho A) ----------
// O webhook add_message do Kommo pode disparar também pra mensagem que o
// PRÓPRIO Salesbot enviou. Se a "inbound" for idêntica à última resposta que
// nós enviamos, é eco — registrar como 'out' e nunca responder (loop!).

/**
 * Normaliza antes de hashear: o texto que volta pelo eco pode diferir do que
 * enviamos por espaço/quebra de linha a mais (o Salesbot re-renderiza o
 * conteúdo). Sem normalizar, o hash não bate e o eco passa como inbound.
 */
function normalizeForHash(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

function hash(text: string): string {
  let h = 0
  const s = normalizeForHash(text)
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return String(h)
}

/**
 * CICATRIZ (produção, 02/09/2026): guardar só o hash da ÚLTIMA resposta com
 * TTL de 10 min deixava eco passar sempre que ele chegava fora de ordem ou
 * atrasado. Resultado: as próprias falas da Sofia entravam no histórico como
 * se fossem do PACIENTE — 30+ mensagens contaminadas num único lead. Isso
 * degrada a resposta em silêncio (o modelo lê "o paciente falou de preço" e
 * passa a recitar preço sozinho).
 *
 * Agora guardamos um CONJUNTO dos últimos hashes enviados (24h), então eco
 * atrasado ou fora de ordem continua sendo reconhecido.
 */
const OUT_HASHES_MAX = 30
const OUT_HASHES_TTL_S = 86400

export async function rememberSent(leadId: number, text: string): Promise<void> {
  const h = hash(text)
  const key = `ak:outhash:${leadId}`
  // mantém o legado por compatibilidade com deploys antigos em trânsito
  await redis.set(`ak:lastout:${leadId}`, h, { ex: 600 })
  await redis.lpush(key, h)
  await redis.ltrim(key, 0, OUT_HASHES_MAX - 1)
  await redis.expire(key, OUT_HASHES_TTL_S)
}

export async function isEchoOfSent(leadId: number, text: string): Promise<boolean> {
  const h = hash(text)
  const recent = await redis.lrange<string>(`ak:outhash:${leadId}`, 0, -1)
  if (recent.some(x => String(x) === h)) return true
  // fallback pro esquema antigo
  const last = await redis.get<string>(`ak:lastout:${leadId}`)
  return !!last && String(last) === h
}
