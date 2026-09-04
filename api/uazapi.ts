import type { VercelRequest, VercelResponse } from '@vercel/node'
import { waitUntil } from '@vercel/functions'
import crypto from 'crypto'
import { processLead } from '../lib/agent'
import { CONFIG } from '../lib/config'
import { CRM_MAP } from '../lib/crm-map'
import { appendMessage, seenMessage, setChannel } from '../lib/history'
import { createLeadWithContact, findOpenLeadByPhone, getLead, sleep, type KommoLead } from '../lib/kommo'
import { redis } from '../lib/redis'
import { transcribeUrl } from '../lib/stt'

/**
 * Webhook da uazapi (Desenho B): a instância manda TUDO (inbound, outbound e
 * fromMe) — o histórico fica completo, incluindo mensagem de humano pelo
 * celular. Configurar na uazapi o webhook de mensagens pra:
 *   https://<deploy>/api/uazapi?secret=XXX
 *
 * ⚠️ O formato do payload varia entre versões da uazapi — este parser é
 * tolerante (procura as chaves comuns), mas VALIDE com um POST real da sua
 * instância antes de ativar (ver README).
 */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: 'uazapi-webhook' })
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' })
  if (String(req.query.secret || '') !== CONFIG.webhookSecret) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  // Relay: a instância só suporta 1 webhook — retransmite o payload cru pro
  // consumidor original (outro inbox no mesmo número) sem segurar a resposta
  if (CONFIG.uazapiRelayUrl) {
    waitUntil(
      fetch(CONFIG.uazapiRelayUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body ?? {}),
      }).then(r => {
        if (!r.ok) console.error(`[uazapi] relay -> ${r.status}`)
      }).catch(e => console.error('[uazapi] relay falhou:', e)),
    )
  }

  // Último payload cru fica 1h no Redis (ak:uazlast) — debug de formato sem
  // caçar log (versões da uazapi variam o shape)
  try {
    await redis.set('ak:uazlast', JSON.stringify(req.body).slice(0, 4000), { ex: 3600 })
  } catch { /* debug nunca derruba o webhook */ }

  const msg = extract(req.body)
  if (!msg) return res.status(200).json({ ok: false, reason: 'payload sem mensagem' })

  const webhookId = crypto.randomUUID()
  waitUntil(ingest(msg, webhookId))
  return res.status(200).json({ ok: true })
}

interface UazMsg {
  id: string
  phone: string
  text: string
  fromMe: boolean
  /** enviado por NÓS via API (eco do próprio agente — ignorar sempre) */
  sentByApi: boolean
  isAudio: boolean
  audioUrl: string
  pushName: string
}

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v)
}

function extract(rawBody: unknown): UazMsg | null {
  if (!rawBody || typeof rawBody !== 'object') return null
  const b = rawBody as Record<string, unknown>
  // uazapi costuma aninhar em "message"; versões variam ({messages: [...]}, plano)
  const nested =
    (typeof b.message === 'object' && b.message) ||
    (Array.isArray(b.messages) && b.messages[0]) ||
    (Array.isArray(b.message) && b.message[0]) ||
    b
  const m = nested as Record<string, unknown>

  const phone = (
    str(m.chatid) || str(m.number) || str(m.phone) || str(m.sender) || str(b.chatid) || str(b.number)
  ).replace(/@.*$/, '').replace(/\D+/g, '')
  if (!phone) return null

  // content pode ser objeto aninhado ({text} / {URL, mimetype}) nesta versão
  const content = (typeof m.content === 'object' && m.content ? m.content : {}) as Record<string, unknown>

  const text = (
    str(m.text) || str(content.text) || str(m.body) || str(m.caption) ||
    str(content.caption) || str(m.conversation) ||
    (typeof m.content === 'string' ? str(m.content) : '')
  ).trim()

  const type = (str(m.messageType) || str(m.mediaType) || str(m.type)).toLowerCase()
  const isAudio = type.includes('audio') || type.includes('ptt')
  // URL direta (algumas versões) — a URL .enc do WhatsApp NÃO serve; o ingest
  // usa POST /message/download pra obter a mídia descriptografada
  const rawUrl = str(content.URL) || str(content.url) || str(m.fileURL) || str(m.file) || str(m.mediaUrl) || str(m.url)
  const audioUrl = isAudio && rawUrl && !rawUrl.includes('.enc') ? rawUrl : ''

  const fromMe = m.fromMe === true || m.fromMe === 'true' || b.fromMe === true
  const sentByApi = m.wasSentByApi === true || m.wasSentByApi === 'true'

  const id = str(m.id) || str(m.messageid) || str(b.id) || `${phone}:${Date.now()}`
  const pushName = str(m.pushName) || str(m.senderName) || str(m.notifyName) || str(b.pushName) || str(m.chatName)
  if (!text && !isAudio) return null
  return { id, phone, text, fromMe, sentByApi, isAudio, audioUrl, pushName }
}

/** Mídia descriptografada/convertida pela própria instância (POST /message/download). */
async function downloadMediaUrl(messageId: string): Promise<string | null> {
  try {
    const res = await fetch(`${CONFIG.uazapiBaseUrl}/message/download`, {
      method: 'POST',
      headers: { token: CONFIG.uazapiToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: messageId }),
    })
    if (!res.ok) {
      console.error(`[uazapi] /message/download -> ${res.status}`)
      return null
    }
    const d = (await res.json()) as { fileURL?: string; url?: string }
    return d.fileURL || d.url || null
  } catch (e) {
    console.error('[uazapi] download de mídia falhou:', e)
    return null
  }
}

async function ingest(m: UazMsg, webhookId: string): Promise<void> {
  try {
    // Eco do NOSSO próprio envio via API: o agente já registrou no histórico
    // na hora de enviar — processar de novo duplicaria (e custaria à toa)
    if (m.fromMe && m.sentByApi) return
    if (await seenMessage(`uaz:${m.id}`)) return

    // Índice telefone→lead (evita a busca fuzzy do Kommo em toda mensagem)
    const phoneKey = `ak:phone2lead:${m.phone}`
    let lead: KommoLead | null = null
    const cachedId = await redis.get<string | number>(phoneKey)
    if (cachedId) {
      try {
        const l = await getLead(Number(cachedId))
        if (l.pipeline_id === CRM_MAP.pipelineId && l.status_id !== 142 && l.status_id !== 143) lead = l
      } catch { /* lead sumiu: cai pra busca */ }
    }
    if (!lead) lead = await findOpenLeadByPhone(m.phone, CRM_MAP.pipelineId)
    if (!lead && CONFIG.uazapiAutoCreateLead && !m.fromMe) {
      // Número dedicado da IA: desconhecido vira lead no funil, já no gate.
      // O lead nasce na PRIMEIRA etapa da alçada do agente (stages[0]) — e
      // não numa posição do stageOrder: aquele array descreve o funil INTEIRO
      // (etapas do time inclusive), então "a segunda posição" significa uma
      // coisa diferente em cada conta.
      const tags = CONFIG.gateTag ? [CONFIG.gateTag.toUpperCase()] : []
      const newId = await createLeadWithContact({
        name: m.pushName || `WhatsApp ${m.phone.slice(-4)}`,
        phone: m.phone,
        pipelineId: CRM_MAP.pipelineId,
        statusId: CRM_MAP.stages[0].id,
        tags,
      })
      console.log(`[uazapi] lead ${newId} criado automático pro número ${m.phone}`)
      // Usa o id devolvido pelo POST. Re-buscar por telefone aqui era bug: a
      // busca do Kommo é indexada e ainda não enxerga o lead recém-criado —
      // voltava null, a mensagem era descartada e a mensagem SEGUINTE criava
      // outro lead (e outro, e outro) até o índice atualizar.
      lead = await getLead(newId)
    }
    if (!lead) {
      console.log(`[uazapi] sem lead aberto no funil pro número ${m.phone} — ignorando`)
      return
    }
    await redis.set(phoneKey, String(lead.id), { ex: 60 * 86400 })

    let text = m.text
    if (!text && m.isAudio) {
      // O webhook dispara ANTES da instância terminar de baixar/converter a
      // mídia (mesma pegadinha da "mídia assíncrona" do GHL) — retry 2s/4s/8s
      for (let attempt = 0; attempt < 4 && !text; attempt++) {
        if (attempt > 0) await sleep(2000 * attempt)
        const url = (await downloadMediaUrl(m.id)) || m.audioUrl
        if (!url) continue
        const t = await transcribeUrl(url)
        if (t) text = `[áudio do lead]: ${t}`
      }
      if (!text) text = '[áudio recebido sem transcrição]'
    }
    if (!text) return

    await appendMessage(lead.id, {
      id: `uaz:${m.id}`,
      dir: m.fromMe ? 'out' : 'in',
      text,
      ts: Date.now(),
    })
    if (m.fromMe) return // registro fiel, mas nunca responder a nós mesmos

    await setChannel(lead.id, 'uazapi')
    await processLead(lead.id, webhookId, { phoneHint: m.phone, via: 'uazapi' })
  } catch (e) {
    console.error(`[uazapi] erro ingerindo msg ${m.id}:`, e)
  }
}
