import type { VercelRequest, VercelResponse } from '@vercel/node'
import { CONFIG } from '../lib/config'
import { CRM_MAP } from '../lib/crm-map'

/**
 * Health-check do CRM_MAP: coerência interna do mapa + comparação com o
 * Kommo AO VIVO. O CRM muda por fora (time renomeia status, deleta campo,
 * mexe em enum) e o mapa envelhece — este endpoint denuncia o drift antes
 * que vire perda silenciosa de dado.
 *
 * GET /api/validate?secret=XXX  →  { ok, problems: [...] }
 * Rodar depois de qualquer mexida no funil/campos, e antes de replicar o mapa.
 */

async function kommoGet<T>(path: string): Promise<T> {
  const res = await fetch(`${CONFIG.kommoDomain}${path}`, {
    headers: {
      Authorization: `Bearer ${CONFIG.kommoToken}`,
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    },
  })
  if (!res.ok) throw new Error(`Kommo GET ${path} -> ${res.status}`)
  return res.json() as Promise<T>
}

interface LiveStatus { id: number; name: string; sort: number }
interface LivePipeline { id: number; name: string; _embedded?: { statuses?: LiveStatus[] } }
interface LiveField {
  id: number
  name: string
  type: string
  enums?: Array<{ id: number; value: string }> | null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.query.secret !== CONFIG.webhookSecret) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  const problems: string[] = []

  // 0. Coerência do próprio crm-map.ts (offline — não depende do Kommo).
  // Estes dois erros não estouram em runtime: eles fazem o agente trabalhar
  // errado calado. Por isso são denunciados aqui, antes de qualquer fetch.

  // 0a. stageOrder é a régua do guard anti-retrocesso (`indexOf(status_id)`).
  // Placeholder não preenchido = guard cego; id repetido = duas etapas
  // resolvendo pro mesmo índice = guard que deixa o lead voltar no funil.
  const vistos = new Set<number>()
  CRM_MAP.stageOrder.forEach((id, i) => {
    if (id <= 0) {
      problems.push(`stageOrder[${i}] = ${id} — placeholder NÃO PREENCHIDO. Troque pelo status_id real (GET /api/v4/leads/pipelines); enquanto isso o guard anti-retrocesso não protege esta posição`)
    } else if (vistos.has(id)) {
      problems.push(`stageOrder[${i}] = ${id} — id REPETIDO no stageOrder. Cada status aparece uma vez só, senão o guard anti-retrocesso confunde as etapas`)
    }
    vistos.add(id)
  })
  for (const s of CRM_MAP.stages) {
    if (!CRM_MAP.stageOrder.includes(s.id)) {
      problems.push(`Etapa da alçada "${s.name}" (${s.id}) não está no stageOrder — a tool mover_etapa_funil nunca vai conseguir mover pra ela`)
    }
  }

  try {
    // 1. Pipeline + statuses
    const pd = await kommoGet<{ _embedded?: { pipelines?: LivePipeline[] } }>('/api/v4/leads/pipelines')
    const pipeline = (pd._embedded?.pipelines || []).find(p => p.id === CRM_MAP.pipelineId)
    if (!pipeline) {
      problems.push(`Pipeline ${CRM_MAP.pipelineId} (${CRM_MAP.pipelineName}) NÃO EXISTE mais`)
    } else {
      if (pipeline.name !== CRM_MAP.pipelineName) {
        problems.push(`Pipeline renomeado: mapa="${CRM_MAP.pipelineName}" kommo="${pipeline.name}"`)
      }
      const live = pipeline._embedded?.statuses || []
      const liveById = new Map(live.map(s => [s.id, s]))
      for (const s of CRM_MAP.stages) {
        const ls = liveById.get(s.id)
        if (!ls) problems.push(`Status da alçada "${s.name}" (${s.id}) não existe mais no funil`)
        else if (ls.name !== s.name) problems.push(`Status ${s.id} renomeado: mapa="${s.name}" kommo="${ls.name}"`)
      }
      const liveOrdered = [...live].sort((a, b) => a.sort - b.sort).map(s => s.id)
      for (const id of liveOrdered) {
        if (!CRM_MAP.stageOrder.includes(id)) {
          problems.push(`Status "${liveById.get(id)?.name}" (${id}) existe no Kommo mas FALTA no stageOrder — guard anti-retrocesso furado`)
        }
      }
      for (const id of CRM_MAP.stageOrder) {
        if (!liveOrdered.includes(id)) problems.push(`Status ${id} está no stageOrder mas não existe mais no Kommo`)
      }
      if (
        CRM_MAP.stageOrder.filter(id => liveOrdered.includes(id)).join(',') !==
        liveOrdered.filter(id => CRM_MAP.stageOrder.includes(id)).join(',')
      ) {
        problems.push('ORDEM do stageOrder diverge da ordem real do funil')
      }
    }

    // 2. Campos custom do LEAD
    const fd = await kommoGet<{ _embedded?: { custom_fields?: LiveField[] } }>('/api/v4/leads/custom_fields?limit=250')
    const liveFields = new Map((fd._embedded?.custom_fields || []).map(f => [f.id, f]))

    const checkField = (id: number, expectedName: string, options?: Array<{ id: number; value: string }>) => {
      const lf = liveFields.get(id)
      if (!lf) {
        problems.push(`Campo "${expectedName}" (${id}) NÃO EXISTE mais no Kommo`)
        return
      }
      if (lf.name.trim() !== expectedName.trim()) {
        problems.push(`Campo ${id} renomeado: mapa="${expectedName}" kommo="${lf.name}"`)
      }
      if (options) {
        const liveEnums = new Map((lf.enums || []).map(e => [e.id, e.value]))
        for (const o of options) {
          const v = liveEnums.get(o.id)
          if (v === undefined) problems.push(`Campo "${expectedName}": enum ${o.id} ("${o.value}") sumiu`)
          else if (v !== o.value) problems.push(`Campo "${expectedName}": enum ${o.id} renomeado "${o.value}" → "${v}"`)
        }
      }
    }

    for (const f of CRM_MAP.leadFields) checkField(f.id, f.kommoName, f.options)
    checkField(CRM_MAP.respostaFieldId, 'Resposta IA (agente)')
    // O campo "Follow-up" só é checado se você preencheu o id (ligou o
    // follow-up automático — ver comentário em lib/crm-map.ts). Dormente,
    // ele fica de fora pra não gritar "campo não existe" à toa.
    if (CRM_MAP.followup.campoCadencia.id > 0) {
      checkField(CRM_MAP.followup.campoCadencia.id, 'Follow-up', CRM_MAP.followup.campoCadencia.options)
    }

    return res.status(problems.length ? 500 : 200).json({
      ok: problems.length === 0,
      pipeline: CRM_MAP.pipelineName,
      transport: CONFIG.transport,
      checkedStages: CRM_MAP.stages.length,
      checkedFields: CRM_MAP.leadFields.length + 1 + (CRM_MAP.followup.campoCadencia.id > 0 ? 1 : 0),
      problems,
    })
  } catch (e) {
    // Falhou o fetch (token errado, Kommo fora do ar): devolve mesmo assim o
    // que já foi conferido offline — o aluno não fica sem diagnóstico nenhum.
    return res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e), problems })
  }
}
