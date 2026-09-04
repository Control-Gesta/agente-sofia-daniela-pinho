import type { VercelRequest, VercelResponse } from '@vercel/node'
import { waitUntil } from '@vercel/functions'
import crypto from 'crypto'
import { processLead } from '../lib/agent'
import { CONFIG } from '../lib/config'
import { appendMessage, getChannel, isEchoOfSent, seenMessage, setChannel } from '../lib/history'
import { transcribeUrl } from '../lib/stt'

/**
 * Webhook de entrada — evento nativo "add_message" do Kommo
 * (POST /api/v4/webhooks {destination, settings: ["add_message"]}).
 *
 * O Kommo envia application/x-www-form-urlencoded com chaves em colchetes:
 *   account[id], message[add][0][id], message[add][0][entity_id] (= lead),
 *   message[add][0][contact_id], message[add][0][text],
 *   message[add][0][attachment][type] (voice|picture|file),
 *   message[add][0][attachment][link]
 * (formato verificado contra webhooks reais de contas em produção)
 */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: 'agente-ia-kommo', transport: CONFIG.transport })
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' })
  }

  const provided = String(req.headers['x-webhook-secret'] || req.query.secret || '')
  if (!timingSafeEq(provided, CONFIG.webhookSecret)) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  const parsed = parseKommoWebhook(req.body)
  if (!parsed) {
    console.warn('[inbound] payload sem message[add]:', JSON.stringify(req.body).slice(0, 400))
    return res.status(200).json({ ok: false, reason: 'sem message[add]' })
  }
  if (parsed.accountId && parsed.accountId !== CONFIG.kommoAccountId) {
    return res.status(200).json({ ok: false, reason: 'outra conta' })
  }

  const webhookId = crypto.randomUUID()
  waitUntil(ingest(parsed, webhookId))
  return res.status(200).json({ ok: true })
}

function timingSafeEq(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest()
  const hb = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(ha, hb)
}

interface InboundMsg {
  id: string
  leadId: number
  text: string
  attachType: string
  attachLink: string
  /** 'incoming' | 'outgoing' | '' (o Kommo nem sempre manda) */
  direction: string
}

interface ParsedWebhook {
  accountId: string
  msgs: InboundMsg[]
}

/** Lê um campo tanto no formato plano ("a[b][0][c]") quanto aninhado. */
function pick(body: Record<string, unknown>, flat: string, nestedPath: Array<string | number>): string {
  const v = body[flat]
  if (v !== undefined && v !== null) return String(v)
  let cur: unknown = body
  for (const k of nestedPath) {
    if (cur === null || typeof cur !== 'object') return ''
    cur = (cur as Record<string, unknown>)[String(k)]
  }
  return cur === undefined || cur === null ? '' : String(cur)
}

function parseKommoWebhook(rawBody: unknown): ParsedWebhook | null {
  if (!rawBody || typeof rawBody !== 'object') return null
  const body = rawBody as Record<string, unknown>
  const accountId = pick(body, 'account[id]', ['account', 'id'])

  const msgs: InboundMsg[] = []
  for (let i = 0; i < 10; i++) {
    const id = pick(body, `message[add][${i}][id]`, ['message', 'add', i, 'id'])
    const entityId = pick(body, `message[add][${i}][entity_id]`, ['message', 'add', i, 'entity_id'])
    const text = pick(body, `message[add][${i}][text]`, ['message', 'add', i, 'text'])
    const attachType = pick(body, `message[add][${i}][attachment][type]`, ['message', 'add', i, 'attachment', 'type'])
    const attachLink = pick(body, `message[add][${i}][attachment][link]`, ['message', 'add', i, 'attachment', 'link'])
    const direction = pick(body, `message[add][${i}][type]`, ['message', 'add', i, 'type']).toLowerCase()
    if (!entityId && !id && !text) break
    const leadId = Number(entityId)
    if (!leadId) continue
    msgs.push({ id: id || `${leadId}:${Date.now()}:${i}`, leadId, text, attachType, attachLink, direction })
  }
  if (msgs.length === 0) return null
  return { accountId, msgs }
}

async function ingest(parsed: ParsedWebhook, webhookId: string): Promise<void> {
  for (const m of parsed.msgs) {
    try {
      // Canal único por lead: número que TAMBÉM está na uazapi entrega a
      // mesma mensagem 2x (add_message + webhook uazapi). Lead marcado como
      // canal uazapi é processado SÓ por lá (é o canal com voz) — aqui ignora.
      if ((await getChannel(m.leadId)) === 'uazapi') {
        console.log(`[inbound] lead ${m.leadId} é do canal uazapi — add_message ignorado`)
        continue
      }
      // Retry de webhook do Kommo não duplica histórico
      if (await seenMessage(`kommo:${m.id}`)) {
        console.log(`[inbound] msg ${m.id} já registrada — ignorando retry`)
        continue
      }

      let text = (m.text || '').trim()
      if (m.attachType === 'voice' || m.attachType === 'audio') {
        const t = m.attachLink ? await transcribeUrl(m.attachLink) : null
        text = t ? `[áudio do lead]: ${t}` : '[áudio recebido sem transcrição]'
      } else if (m.attachType === 'picture') {
        text = text || '[imagem recebida]'
      } else if (m.attachType === 'file') {
        text = text || '[arquivo recebido]'
      }
      if (!text) continue

      // Anti-loop em camadas: (1) eco da nossa própria resposta entregue
      // pelo Salesbot — já registrada no envio, NÃO duplicar nem responder;
      // (2) direção explícita quando o Kommo manda (ex: humano pelo Kommo)
      if (await isEchoOfSent(m.leadId, text)) {
        console.log(`[inbound] msg ${m.id} é eco da nossa resposta — ignorando`)
        continue
      }
      const isOutgoing = m.direction === 'outgoing'
      await appendMessage(m.leadId, {
        id: `kommo:${m.id}`,
        dir: isOutgoing ? 'out' : 'in',
        text,
        ts: Date.now(),
      })
      if (isOutgoing) {
        console.log(`[inbound] msg ${m.id} é outbound — registrada, sem resposta`)
        continue
      }

      await setChannel(m.leadId, 'kommo')
      await processLead(m.leadId, webhookId, { via: 'kommo' })
    } catch (e) {
      console.error(`[inbound] erro ingerindo msg ${m.id}:`, e)
    }
  }
}
