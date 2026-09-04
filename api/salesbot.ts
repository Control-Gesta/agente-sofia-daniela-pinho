import type { VercelRequest, VercelResponse } from '@vercel/node'
import { CONFIG } from '../lib/config'
import { getOutbox } from '../lib/transport'

/**
 * Callback do widget-request do Salesbot de envio:
 *
 *   Bot passo 0: widget-request → POST https://<deploy>/api/salesbot?secret=XXX
 *                (o Kommo manda data[lead_id] + return_url, form-urlencoded)
 *   Nós:         POST return_url {data: {resposta_ia}, execute_handlers: [goto step 1]}
 *   Bot passo 1: envia a mensagem {{json.resposta_ia}}
 *
 * A resposta em si fica no outbox (Redis, 10 min) — o transport grava lá
 * ANTES de disparar o /api/v2/salesbot/run, então o texto sempre existe.
 */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, service: 'salesbot-callback' })
  }
  if (String(req.query.secret || '') !== CONFIG.webhookSecret) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  const body = (req.body || {}) as Record<string, unknown>
  const leadId = Number(
    body['data[lead_id]'] ??
    (body.data as Record<string, unknown> | undefined)?.lead_id ??
    body.lead_id ?? 0,
  )
  const returnUrl = String(body.return_url || '')

  if (!leadId || !returnUrl.startsWith('http')) {
    console.warn('[salesbot] callback sem lead_id/return_url:', JSON.stringify(body).slice(0, 300))
    return res.status(200).json({ ok: false })
  }

  const text = (await getOutbox(leadId)) || ''
  if (!text) {
    console.warn(`[salesbot] outbox vazio pro lead ${leadId} (run atrasado ou duplicado?)`)
  }

  try {
    const r = await fetch(returnUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CONFIG.kommoToken}`,
      },
      body: JSON.stringify({
        data: { resposta_ia: text },
        // continua o bot no passo 1 (o bloco que envia {{json.resposta_ia}})
        execute_handlers: text
          ? [{ handler: 'goto', params: { type: 'question', step: 1 } }]
          : [],
      }),
    })
    if (!r.ok) {
      console.error(`[salesbot] return_url -> ${r.status}: ${(await r.text()).slice(0, 200)}`)
    }
  } catch (e) {
    console.error('[salesbot] falha no POST do return_url:', e)
  }

  return res.status(200).json({ ok: true })
}
