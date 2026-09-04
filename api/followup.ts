import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'crypto'
import { generateFollowup } from '../lib/llm'
import { CONFIG } from '../lib/config'
import { CRM_MAP } from '../lib/crm-map'
import { clearFollowup, dentroDaJanela, getDue, scheduleSilenceCheck } from '../lib/followup'
import { appendMessage, getChannel, getHistory, lastIsInbound } from '../lib/history'
import { addLeadTags, getLead, updateLeadFields, updateLeadStatus } from '../lib/kommo'
import { sendReply } from '../lib/transport'

/**
 * Motor de followup — Vercel Cron (1x/dia no plano Hobby).
 * Envia a próxima cadência pra leads que ficaram mudos, dentro da janela
 * comercial. Esgotou as 4: tag + status "Venda perdida".
 *
 * ⚠️ Janela de 24h da Meta: com WhatsApp OFICIAL no Kommo (transport
 * salesbot), cadências 2+ caem fora da janela e texto livre NÃO ENTREGA —
 * é limitação da Meta, sem erro visível. Mitigações: uazapi (sem janela) ou
 * bot de envio com bloco de TEMPLATE aprovado (ver README).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const bearer = String(req.headers.authorization || '')
  const authorized =
    (process.env.CRON_SECRET && bearer === `Bearer ${process.env.CRON_SECRET}`) ||
    req.query.secret === CONFIG.webhookSecret
  if (!authorized) return res.status(401).json({ error: 'unauthorized' })

  // force=1: bypass da janela pra testes manuais (exige o secret)
  if (!dentroDaJanela() && req.query.force !== '1') {
    return res.status(200).json({ ok: true, skipped: 'fora da janela comercial' })
  }

  const due = await getDue(CRM_MAP.followup.maxPorRodada)
  const resultado = { enviados: 0, esgotados: 0, pulados: 0, erros: 0 }

  const lote = CRM_MAP.followup.concorrencia
  for (let i = 0; i < due.length; i += lote) {
    await Promise.all(due.slice(i, i + lote).map(item => processOne(item, resultado)))
  }

  return res.status(200).json({ ok: true, vencidos: due.length, ...resultado })
}

type Resultado = { enviados: number; esgotados: number; pulados: number; erros: number }

async function processOne(item: { leadId: number; cadenciaEnviada: number }, resultado: Resultado): Promise<void> {
  const { leadId } = item
  const t0 = Date.now()
  try {
    const lead = await getLead(leadId)
    const nome = lead.name || `lead ${leadId}`
    const tags = (lead._embedded?.tags || []).map(t => t.name.toLowerCase())

    // Fora do gate, com humano, ou saiu do funil: sai do ciclo em silêncio
    const foraDoFunil = lead.pipeline_id !== CRM_MAP.pipelineId || lead.status_id === 142 || lead.status_id === 143
    if ((CONFIG.gateTag && !tags.includes(CONFIG.gateTag)) || tags.includes(CONFIG.humanTag) || foraDoFunil) {
      await clearFollowup(leadId)
      resultado.pulados++
      return
    }

    const history = await getHistory(leadId)
    if (history.length === 0) { await clearFollowup(leadId); resultado.pulados++; return }

    // Lead respondeu nesse meio tempo — o fluxo normal assume
    if (lastIsInbound(history)) {
      await clearFollowup(leadId)
      resultado.pulados++
      return
    }

    const proxima = item.cadenciaEnviada + 1

    if (proxima > CRM_MAP.followup.intervalosHoras.length) {
      // Esgotou: tag + venda perdida
      await addLeadTags(leadId, [CRM_MAP.followup.aoEsgotar.tag])
      try {
        await updateLeadStatus(leadId, CRM_MAP.followup.aoEsgotar.statusId, CRM_MAP.pipelineId)
      } catch (e) { console.error('[followup] falha ao perder lead:', e) }
      await clearFollowup(leadId)
      console.log(`[followup] lead ${leadId} (${nome}) esgotou as cadências sem resposta — venda perdida`)
      resultado.esgotados++
      return
    }

    const msg = await generateFollowup(lead, history, proxima)
    if (!msg) {
      console.error(`[followup] sem mensagem gerada pro lead ${leadId}`)
      await scheduleSilenceCheck(leadId, item.cadenciaEnviada) // tenta de novo depois
      resultado.erros++
      return
    }

    // Followup sai pelo canal onde o lead conversa (uazapi = sem janela 24h)
    const via = (await getChannel(leadId)) ?? undefined
    await sendReply(lead, [msg], { voice: false, voiceText: '', via })
    await appendMessage(leadId, { id: crypto.randomUUID(), dir: 'out', text: msg, ts: Date.now() })

    // Marca a cadência no card (campo select "Follow-up")
    const opt = CRM_MAP.followup.campoCadencia.options[proxima - 1]
    if (opt) {
      try {
        await updateLeadFields(leadId, [
          { field_id: CRM_MAP.followup.campoCadencia.id, values: [{ enum_id: opt.id }] },
        ])
      } catch (e) { console.error('[followup] falha ao marcar cadência no card:', e) }
    }

    await scheduleSilenceCheck(leadId, proxima)
    console.log(`[followup] lead ${leadId} (${nome}) — cadência ${proxima} enviada em ${Date.now() - t0}ms`)
    resultado.enviados++
  } catch (e) {
    console.error(`[followup] erro com lead ${leadId} após ${Date.now() - t0}ms:`, e)
    resultado.erros++
  }
}
