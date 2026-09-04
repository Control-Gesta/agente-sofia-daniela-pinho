import { CONFIG } from './config'

/**
 * Client da API do Kommo (v4 + o endpoint legado v2 do Salesbot).
 * - Retry com backoff em 429/5xx; senders passam retry5xx: false (um 502 de
 *   gateway pode ter executado o run — repetir duplicaria mensagem).
 * - PATCH de tags no Kommo SUBSTITUI o conjunto inteiro — use addLeadTags/
 *   removeLeadTags (merge local) e nunca PATCH _embedded.tags na mão.
 */

function headers(json = false): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${CONFIG.kommoToken}`,
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  }
  if (json) h['Content-Type'] = 'application/json'
  return h
}

async function kommo<T>(method: string, path: string, body?: unknown, opts?: { retries?: number; retry5xx?: boolean }): Promise<T> {
  const retries = opts?.retries ?? 3
  const retry5xx = opts?.retry5xx ?? true
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${CONFIG.kommoDomain}${path}`, {
      method,
      headers: headers(!!body),
      body: body ? JSON.stringify(body) : undefined,
    })
    if (res.ok) {
      // 204 No Content acontece em alguns PATCH
      const text = await res.text()
      return (text ? JSON.parse(text) : {}) as T
    }
    const text = await res.text()
    const retryable = res.status === 429 || (retry5xx && res.status >= 500)
    if (retryable && attempt < retries) {
      await sleep(res.status === 429 ? 2000 * 2 ** attempt : 1000 * (attempt + 1))
      continue
    }
    throw new Error(`Kommo ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`)
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ---------- Tipos ----------

export interface KommoTag {
  id: number
  name: string
}

export interface KommoFieldValue {
  field_id: number
  values: Array<{ value?: unknown; enum_id?: number }>
}

export interface KommoLead {
  id: number
  name?: string
  status_id: number
  pipeline_id: number
  /** epoch em SEGUNDOS — usado pra saber se o lead é novo (ver lib/agent.ts) */
  created_at?: number
  responsible_user_id?: number
  custom_fields_values?: KommoFieldValue[] | null
  _embedded?: {
    tags?: KommoTag[]
    contacts?: Array<{ id: number; is_main?: boolean }>
  }
}

export interface KommoContact {
  id: number
  name?: string
  custom_fields_values?: Array<{
    field_id: number
    field_code?: string
    values: Array<{ value?: unknown }>
  }> | null
}

// ---------- Leads ----------

export async function getLead(leadId: number): Promise<KommoLead> {
  return kommo<KommoLead>('GET', `/api/v4/leads/${leadId}?with=contacts`)
}

export async function updateLeadStatus(leadId: number, statusId: number, pipelineId: number): Promise<void> {
  await kommo('PATCH', `/api/v4/leads/${leadId}`, { status_id: statusId, pipeline_id: pipelineId })
}

export async function updateLeadFields(leadId: number, values: KommoFieldValue[]): Promise<void> {
  await kommo('PATCH', `/api/v4/leads/${leadId}`, { custom_fields_values: values })
}

/** Valor atual de um campo custom do lead (primeiro value), ou null. */
export function fieldValue(lead: KommoLead, fieldId: number): unknown | null {
  const f = (lead.custom_fields_values || []).find(v => v.field_id === fieldId)
  return f?.values?.[0]?.value ?? null
}

/** enum_ids atuais de um multiselect do lead. */
export function fieldEnumIds(lead: KommoLead, fieldId: number): number[] {
  const f = (lead.custom_fields_values || []).find(v => v.field_id === fieldId)
  return (f?.values || []).map(v => v.enum_id).filter((x): x is number => typeof x === 'number')
}

// ---------- Tags (PATCH substitui TUDO — sempre merge) ----------

async function setLeadTags(leadId: number, names: string[]): Promise<void> {
  await kommo('PATCH', `/api/v4/leads/${leadId}`, {
    _embedded: { tags: names.map(name => ({ name })) },
  })
}

export async function addLeadTags(leadId: number, names: string[]): Promise<void> {
  const lead = await getLead(leadId)
  const current = (lead._embedded?.tags || []).map(t => t.name)
  const lower = new Set(current.map(t => t.toLowerCase()))
  const merged = [...current, ...names.filter(n => !lower.has(n.toLowerCase()))]
  await setLeadTags(leadId, merged)
}

/**
 * Contraparte do addLeadTags. O agente só ACRESCENTA tag, então nada no
 * pipeline chama isto hoje — existe pro dia em que você precisar tirar uma
 * tag (ex: religar o agente removendo a de "atendimento-humano") sem apagar
 * as outras no caminho. Pode apagar sem quebrar nada.
 */
export async function removeLeadTags(leadId: number, namesLower: string[]): Promise<void> {
  const lead = await getLead(leadId)
  const drop = new Set(namesLower.map(n => n.toLowerCase()))
  const kept = (lead._embedded?.tags || []).map(t => t.name).filter(n => !drop.has(n.toLowerCase()))
  await setLeadTags(leadId, kept)
}

/**
 * Acrescenta e remove tags numa ÚNICA escrita. Existe porque chamar
 * addLeadTags e depois removeLeadTags cria uma janela (2 leituras + 2
 * escritas) em que o card fica com as duas tags ao mesmo tempo — na
 * escalação, "atendimento-humano" junto com a tag de gate dá a leitura
 * errada pro time ("parece que a IA está ativa, mas não está").
 */
export async function swapLeadTags(leadId: number, add: string[], removeLower: string[]): Promise<void> {
  const lead = await getLead(leadId)
  const drop = new Set(removeLower.map(n => n.toLowerCase()))
  const kept = (lead._embedded?.tags || []).map(t => t.name).filter(n => !drop.has(n.toLowerCase()))
  const lower = new Set(kept.map(t => t.toLowerCase()))
  const final = [...kept, ...add.filter(n => !lower.has(n.toLowerCase()) && !drop.has(n.toLowerCase()))]
  await setLeadTags(leadId, final)
}

// ---------- Contacts ----------

export async function getContact(contactId: number): Promise<KommoContact> {
  return kommo<KommoContact>('GET', `/api/v4/contacts/${contactId}`)
}

/** Telefone do contato principal do lead (só dígitos), ou null. */
export async function getLeadPhone(lead: KommoLead): Promise<string | null> {
  const main = (lead._embedded?.contacts || []).find(c => c.is_main) || (lead._embedded?.contacts || [])[0]
  if (!main) return null
  const contact = await getContact(main.id)
  for (const f of contact.custom_fields_values || []) {
    if (f.field_code === 'PHONE') {
      const v = String(f.values?.[0]?.value || '').replace(/\D+/g, '')
      if (v) return v
    }
  }
  return null
}

/**
 * Lead ABERTO mais recente de um telefone, no pipeline do mapa (fluxo uazapi:
 * a mensagem chega com o número, não com o lead_id). null = ignorar mensagem.
 *
 * A busca do Kommo é fuzzy e contas antigas acumulam contatos de teste com o
 * mesmo número — por isso: limite alto + validação do TELEFONE do contato
 * dígito a dígito antes de considerar os leads dele.
 */
export async function findOpenLeadByPhone(phoneDigits: string, pipelineId: number): Promise<KommoLead | null> {
  const tail = phoneDigits.replace(/\D+/g, '').slice(-10) // DDD + número (ignora DDI/9º dígito)
  const q = phoneDigits.slice(-11)
  const d = await kommo<{ _embedded?: { contacts?: Array<KommoContact & { _embedded?: { leads?: Array<{ id: number }> } }> } }>(
    'GET',
    `/api/v4/contacts?query=${encodeURIComponent(q)}&with=leads&limit=10`,
  )
  const contacts = d._embedded?.contacts || []
  const leadIds: number[] = []
  for (const c of contacts) {
    const phones = (c.custom_fields_values || [])
      .filter(f => f.field_code === 'PHONE')
      .flatMap(f => (f.values || []).map(v => String(v.value || '').replace(/\D+/g, '')))
    const bate = phones.some(p => {
      const pt = p.slice(-10)
      // tolera 9º dígito ausente de um dos lados (8 últimos batem)
      return pt === tail || (pt.length >= 8 && tail.endsWith(pt.slice(-8)))
    })
    if (!bate) continue
    for (const l of c._embedded?.leads || []) leadIds.push(l.id)
  }
  let best: KommoLead | null = null
  for (const id of [...new Set(leadIds)].slice(0, 12)) {
    try {
      const lead = await getLead(id)
      if (lead.pipeline_id !== pipelineId) continue
      if (lead.status_id === 142 || lead.status_id === 143) continue
      if (!best || lead.id > best.id) best = lead
    } catch { /* lead pode ter sido apagado */ }
  }
  return best
}

/**
 * Nota de texto no card do lead (aba de anotações).
 * Helper didático: NÃO é usada pelo agente por padrão — está aqui como bloco
 * pronto pra quando você quiser deixar rastro no card (ex: registrar um aviso
 * operacional). Se não for usar, pode apagar sem quebrar nada.
 */
export async function addLeadNote(leadId: number, text: string): Promise<void> {
  await kommo('POST', `/api/v4/leads/${leadId}/notes`, [{
    note_type: 'common',
    params: { text },
  }])
}

/**
 * Cria lead + contato com telefone num POST só (fluxo uazapi em número
 * dedicado da IA: número desconhecido vira lead no funil, já com a tag do
 * gate). Retorna o id do lead criado.
 */
export async function createLeadWithContact(params: {
  name: string
  phone: string
  pipelineId: number
  statusId: number
  tags: string[]
}): Promise<number> {
  const d = await kommo<Array<{ id: number }>>('POST', '/api/v4/leads/complex', [{
    name: params.name,
    pipeline_id: params.pipelineId,
    status_id: params.statusId,
    _embedded: {
      tags: params.tags.map(name => ({ name })),
      contacts: [{
        name: params.name,
        custom_fields_values: [{
          field_code: 'PHONE',
          values: [{ value: params.phone, enum_code: 'WORK' }],
        }],
      }],
    },
  }])
  const id = d?.[0]?.id
  if (!id) throw new Error('leads/complex não retornou id')
  return id
}

// ---------- Tasks (agendamento de reunião) ----------

export async function createTask(params: {
  leadId: number
  text: string
  completeTillEpoch: number
  responsibleUserId: number
  taskTypeId: number
}): Promise<void> {
  await kommo('POST', '/api/v4/tasks', [{
    task_type_id: params.taskTypeId,
    text: params.text,
    complete_till: params.completeTillEpoch,
    entity_id: params.leadId,
    entity_type: 'leads',
    responsible_user_id: params.responsibleUserId,
  }])
}

// ---------- Salesbot (envio indireto — endpoint legado v2) ----------

/** Dispara o Salesbot de envio pro lead (o bot busca a resposta no /api/salesbot ou no campo). */
export async function runSalesbot(botId: number, leadId: number): Promise<void> {
  await kommo('POST', '/api/v2/salesbot/run', [{
    bot_id: botId,
    entity_id: leadId,
    entity_type: 'leads',
  }], { retry5xx: false })
}
