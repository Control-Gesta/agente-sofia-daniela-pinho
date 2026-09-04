import { CRM_MAP } from './crm-map'

/**
 * A Sofia só atende FORA do horário em que a recepção humana está na
 * clínica. Dentro do horário humano (seg-sex, 8h-18h, exceto feriado), ela
 * fica calada de propósito — quem responde é a equipe. Config em
 * `crm-map.ts` → `atendimentoHumano`.
 */
export function dentroDoHorarioHumano(d = new Date()): boolean {
  const cfg = CRM_MAP.atendimentoHumano
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: cfg.timezone, hour: 'numeric', hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d)

  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  const hour = Number(get('hour'))
  const wd = get('weekday')
  const dia = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd] ?? 0
  const dataISO = `${get('year')}-${get('month')}-${get('day')}`

  if (cfg.feriados.includes(dataISO)) return false
  if (!cfg.diasSemana.includes(dia)) return false
  return hour >= cfg.inicioHora && hour < cfg.fimHora
}
