import { CONFIG } from './config'
import { CRM_MAP } from './crm-map'
import { rememberSent, type Channel } from './history'
import { getLeadPhone, runSalesbot, sleep, updateLeadFields, type KommoLead } from './kommo'
import { redis } from './redis'
import { textToVoiceBase64 } from './voice'

/**
 * Camada de envio — a API v4 do Kommo NÃO envia mensagem de chat, então:
 *
 * TRANSPORT=salesbot (Desenho A — WhatsApp oficial conectado no Kommo):
 *   1. resposta vai pro campo "Resposta IA (agente)" do lead E pro outbox
 *      (Redis, 10 min) — o bot escolhe de onde ler
 *   2. POST /api/v2/salesbot/run dispara o bot de envio
 *   3. O bot: widget-request em /api/salesbot OU bloco "enviar mensagem"
 *      com o campo do lead
 *   Limitações: 1 mensagem por resposta (partes viram parágrafos), sem voz.
 *
 * TRANSPORT=uazapi (Desenho B — WhatsApp na uazapi, Kommo só CRM):
 *   envio direto: multi-mensagem + voice note nativa (ptt).
 */

const outboxKey = (leadId: number) => `ak:outbox:${leadId}`

export interface SendResult {
  ok: boolean
  voice: boolean
  detail: string
}

export async function getOutbox(leadId: number): Promise<string | null> {
  const text = await redis.get<string>(outboxKey(leadId))
  if (text) await redis.del(outboxKey(leadId))
  return text || null
}

async function uazapi(path: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${CONFIG.uazapiBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      token: CONFIG.uazapiToken,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`uazapi ${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
}

async function resolvePhone(lead: KommoLead, phoneHint?: string): Promise<string> {
  if (phoneHint) return phoneHint
  const phone = await getLeadPhone(lead)
  if (!phone) throw new Error(`lead ${lead.id} sem telefone no contato principal`)
  return phone
}

/**
 * Envia a resposta do agente. `parts` = parágrafos (máx 3); `voiceText` =
 * texto pra síntese quando o modelo pediu áudio. Fallbacks internos garantem
 * que o lead nunca fica sem resposta se a voz falhar.
 */
export async function sendReply(
  lead: KommoLead,
  parts: string[],
  opts: { voice: boolean; voiceText: string; phoneHint?: string; via?: Channel },
): Promise<SendResult> {
  const fullText = parts.join('\n\n')
  // Transport dinâmico: responde pelo canal onde a mensagem entrou;
  // sem canal conhecido, usa o default do env
  const mode: Channel = opts.via ?? (CONFIG.transport === 'uazapi' ? 'uazapi' : 'kommo')

  if (mode === 'uazapi') {
    if (!CONFIG.uazapiBaseUrl || !CONFIG.uazapiToken) {
      throw new Error('canal uazapi sem UAZAPI_BASE_URL/UAZAPI_TOKEN configurados')
    }
    const phone = await resolvePhone(lead, opts.phoneHint)
    if (opts.voice) {
      const b64 = await textToVoiceBase64(opts.voiceText)
      if (b64) {
        try {
          // ptt = voice note de verdade (bolinha + waveform)
          await uazapi('/send/media', {
            number: phone,
            type: 'ptt',
            file: `data:audio/ogg;base64,${b64}`,
          })
          await rememberSent(lead.id, opts.voiceText)
          return { ok: true, voice: true, detail: 'voz via uazapi' }
        } catch (e) {
          console.error('[transport] falha no envio de voz — caindo pra texto:', e)
        }
      }
    }
    for (const part of parts) {
      await uazapi('/send/text', { number: phone, text: part })
      await sleep(800)
    }
    await rememberSent(lead.id, fullText)
    // Se o modelo pediu voz e caímos aqui, o `detail` carimba o fallback: ele
    // sai na linha "[agente] respondi lead ..." do log nativo da Vercel
    return {
      ok: true,
      voice: false,
      detail: opts.voice ? `${parts.length} msg via uazapi (FALLBACK de voz — síntese falhou)` : `${parts.length} msg via uazapi`,
    }
  }

  // ---- salesbot ----
  // Deposita a resposta ANTES de disparar o bot: campo do lead E outbox — o
  // bot de envio escolhe o método (ver README), e a resposta nunca se perde
  // mesmo se o run falhar (dá pra reprocessar/debugar pelo card do lead).
  await updateLeadFields(lead.id, [
    { field_id: CRM_MAP.respostaFieldId, values: [{ value: fullText }] },
  ])
  await redis.set(outboxKey(lead.id), fullText, { ex: 600 })
  if (!CONFIG.kommoBotId) throw new Error('KOMMO_BOT_ID ausente (transport salesbot) — resposta ficou no campo "Resposta IA (agente)" e no outbox')
  await runSalesbot(CONFIG.kommoBotId, lead.id)
  // Anti-eco: o add_message pode disparar pra mensagem que o bot enviar
  await rememberSent(lead.id, fullText)
  return { ok: true, voice: false, detail: 'salesbot/run disparado' }
}
