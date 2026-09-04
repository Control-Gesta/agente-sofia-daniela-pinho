import { CRM_MAP } from './crm-map'
import { redis } from './redis'

/**
 * Fila de followup no Redis:
 *  - sorted set `ak:fu:queue` (score = quando checar, member = leadId)
 *  - hash `ak:fu:{leadId}` = { cadencia } (última cadência JÁ enviada; 0 = nenhuma)
 *
 * Ciclo: agente responde → agenda checagem de silêncio. Lead respondeu?
 * O fluxo normal reseta pra cadência 0. Ficou mudo? O cron envia a próxima
 * cadência e reagenda. Após a 4ª sem resposta: esgota (tag + venda perdida).
 */

const QUEUE = 'ak:fu:queue'
const state = (id: number) => `ak:fu:${id}`

/** Agenda a próxima checagem de silêncio. cadenciaEnviada = 0 (resposta normal) a 4. */
export async function scheduleSilenceCheck(leadId: number, cadenciaEnviada: number): Promise<void> {
  const idx = Math.min(cadenciaEnviada, CRM_MAP.followup.intervalosHoras.length - 1)
  const horas = CRM_MAP.followup.intervalosHoras[idx]
  const nextAt = Date.now() + horas * 3600_000
  await redis.zadd(QUEUE, { score: nextAt, member: String(leadId) })
  await redis.hset(state(leadId), { cadencia: cadenciaEnviada })
  await redis.expire(state(leadId), 60 * 86400)
}

/** Lead respondeu / saiu do fluxo — zera o ciclo. */
export async function clearFollowup(leadId: number): Promise<void> {
  await redis.zrem(QUEUE, String(leadId))
  await redis.del(state(leadId))
}

export interface DueItem {
  leadId: number
  cadenciaEnviada: number
}

/** Leads cuja checagem venceu. */
export async function getDue(limit: number): Promise<DueItem[]> {
  const ids = await redis.zrange<string[]>(QUEUE, 0, Date.now(), {
    byScore: true, offset: 0, count: limit,
  })
  const out: DueItem[] = []
  for (const id of ids) {
    const h = await redis.hget<number>(state(Number(id)), 'cadencia')
    out.push({ leadId: Number(id), cadenciaEnviada: Number(h ?? 0) })
  }
  return out
}

/** Janela de envio comercial (TZ do cliente). */
export function dentroDaJanela(d = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CRM_MAP.followup.timezone, hour: 'numeric', hour12: false, weekday: 'short',
  }).formatToParts(d)
  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? 0)
  const wd = parts.find(p => p.type === 'weekday')?.value ?? ''
  const dia = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd] ?? 0
  const j = CRM_MAP.followup.janela
  return j.diasSemana.includes(dia) && hour >= j.inicioHora && hour < j.fimHora
}
