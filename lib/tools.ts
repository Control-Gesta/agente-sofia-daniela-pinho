import { CONFIG } from './config'
import { CRM_MAP } from './crm-map'
import { clearFollowup } from './followup'
import {
  addLeadTags, fieldEnumIds, fieldValue, getLead, swapLeadTags,
  updateLeadFields, updateLeadStatus, type KommoLead,
} from './kommo'

// Rótulos legíveis das etapas para o modelo. As da alçada vêm do crm-map;
// 142/143 são ids fixos do Kommo em qualquer conta. Se você quiser que a
// buscar_dados_lead mostre nome bonito das etapas FORA da alçada (ex:
// "Incoming leads"), acrescente `[<status_id>, '<nome>']` aqui.
const stageNames = new Map<number, string>([
  [142, 'Ganho (won)'],
  [143, 'Venda perdida'],
  ...CRM_MAP.stages.map(s => [s.id, s.name] as [number, string]),
])

/** Formato de tool no padrão OpenAI function-calling (Chat Completions). */
export interface OpenAiTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required: string[]
    }
  }
}

// A Sofia NÃO agenda consulta, não mexe em calendário nem confirma Pix (guia
// do cliente, seção 3.1) — a alçada dela termina na tag "Lead para Agendar" +
// escalar_para_humano. Por isso não existe tool de marcar reunião aqui.
export const TOOLS: OpenAiTool[] = [
  {
    type: 'function',
    function: {
      name: 'buscar_dados_lead',
      description: 'Busca os dados atuais do lead no CRM: nome, tags, etapa do funil e campos de qualificação já preenchidos. Use quando precisar de contexto que não está na conversa.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'adicionar_tag',
      description: 'Adiciona uma tag de interesse ao lead no CRM. A tag recebe automaticamente o prefixo "ia-" (ex: você passa "interesse-botox" e vira "ia-interesse-botox").',
      parameters: {
        type: 'object',
        properties: {
          tag: { type: 'string', description: 'Tag em minúsculas, sem acento, ex: "interesse-botox"' },
        },
        required: ['tag'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mover_etapa_funil',
      description: [
        `Move o lead no funil "${CRM_MAP.pipelineName}".`,
        `Etapas disponíveis e quando usar cada uma:`,
        ...CRM_MAP.stages.map(s => `- "${s.name}": ${s.quando}`),
        `Você só move o lead PRA FRENTE no funil, nunca pra trás. Se ele já estiver numa etapa mais avançada, a tool recusa — isso é normal, não insista.`,
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          etapa: { type: 'string', enum: CRM_MAP.stages.map(s => s.name), description: 'Nome da etapa de destino' },
        },
        required: ['etapa'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'preencher_qualificacao',
      description: [
        `Preenche um campo de qualificação do lead no CRM. Use assim que a informação aparecer na conversa — não espere.`,
        `Campos e quando preencher:`,
        ...CRM_MAP.leadFields.map(f => `- "${f.name}": quando ${f.quando}${f.options ? ` (opções válidas: ${f.options.map(o => o.value).join(' | ')})` : ''}`),
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          campo: { type: 'string', enum: CRM_MAP.leadFields.map(f => f.name), description: 'Nome do campo' },
          valor: { type: 'string', description: 'Valor extraído da conversa. Pra campos com opções, use exatamente as opções válidas (várias: separe por vírgula).' },
        },
        required: ['campo', 'valor'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalar_para_humano',
      description: 'Transfere o atendimento pra um humano do time (recepção/secretária real da clínica). Use quando: o paciente confirmar que entendeu e concorda com a política comercial da consulta e quiser agendar; quando pedir explicitamente falar com uma pessoa ou ligação; quando estiver irritado; ou quando o assunto fugir do seu escopo (diagnóstico, valores de cirurgias complexas, anestesia/riscos/dor, Pix, calendário). Depois de usar esta tool, se despeça avisando que alguém do time vai assumir.',
      parameters: {
        type: 'object',
        properties: {
          motivo: { type: 'string', description: 'Motivo curto da escalação' },
        },
        required: ['motivo'],
      },
    },
  },
]

export interface ToolOutcome {
  content: string
  isError: boolean
}

// Cache curto do lead: o modelo costuma chamar 2-3 tools de CRM no mesmo
// turno — evita re-buscar e reduz janela de inconsistência.
const leadCache = new Map<number, { lead: KommoLead; ts: number }>()
const LEAD_CACHE_TTL_MS = 60_000

async function getLeadCached(leadId: number): Promise<KommoLead> {
  const hit = leadCache.get(leadId)
  if (hit && Date.now() - hit.ts < LEAD_CACHE_TTL_MS) return hit.lead
  const lead = await getLead(leadId)
  leadCache.set(leadId, { lead, ts: Date.now() })
  return lead
}

function normalize(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()
}

function ok(content: string): ToolOutcome {
  return { content, isError: false }
}
function err(content: string): ToolOutcome {
  return { content, isError: true }
}

export async function runTool(leadId: number, name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
  try {
    switch (name) {
      case 'buscar_dados_lead': {
        const lead = await getLead(leadId)
        leadCache.set(leadId, { lead, ts: Date.now() })
        const campos: Record<string, unknown> = {}
        for (const f of CRM_MAP.leadFields) {
          if (f.multi) {
            const ids = fieldEnumIds(lead, f.id)
            if (ids.length > 0) {
              campos[f.name] = (f.options || []).filter(o => ids.includes(o.id)).map(o => o.value)
            }
          } else {
            const v = fieldValue(lead, f.id)
            if (v !== null && v !== '') campos[f.name] = v
          }
        }
        return ok(JSON.stringify({
          nome: lead.name || null,
          etapaAtual: stageNames.get(lead.status_id) || `status ${lead.status_id}`,
          tags: (lead._embedded?.tags || []).map(t => t.name),
          campos,
        }))
      }
      case 'adicionar_tag': {
        // Prefixo "ia-" obrigatório: prompt injection do lead não consegue
        // criar tag arbitrária que dispare automações nem as tags de controle
        const raw = String(input.tag || '').toLowerCase().trim()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
        if (!raw) return err('Tag vazia ou inválida.')
        const tag = raw.startsWith('ia-') ? raw : `ia-${raw}`
        if (tag === CONFIG.humanTag || raw === CONFIG.humanTag) {
          return err('Use a tool escalar_para_humano para transferir o atendimento.')
        }
        if (CONFIG.gateTag && (tag === CONFIG.gateTag || raw === CONFIG.gateTag)) {
          return err('Essa tag é de controle do sistema — escolha outro nome.')
        }
        await addLeadTags(leadId, [tag])
        leadCache.delete(leadId)
        return ok(`Tag "${tag}" adicionada.`)
      }
      case 'mover_etapa_funil': {
        const etapaName = String(input.etapa || '')
        const stage = CRM_MAP.stages.find(s => s.name === etapaName)
        if (!stage) return err(`Etapa "${etapaName}" não existe. Opções: ${CRM_MAP.stages.map(s => s.name).join(', ')}`)

        const lead = await getLeadCached(leadId)
        if (lead.pipeline_id !== CRM_MAP.pipelineId) {
          return err(`O lead está em outro funil (${lead.pipeline_id}) — você só atua no "${CRM_MAP.pipelineName}". Siga a conversa normalmente.`)
        }
        const currentIdx = CRM_MAP.stageOrder.indexOf(lead.status_id)
        const targetIdx = CRM_MAP.stageOrder.indexOf(stage.id)
        // Fail-closed: etapa atual desconhecida = mapa desatualizado — NÃO mover
        if (currentIdx === -1) {
          console.error(`[crm-map] status desconhecido ${lead.status_id} (lead ${leadId}) — crm-map.ts desatualizado? Rode /api/validate`)
          return err('A etapa atual do lead não é reconhecida pelo mapa — não vou mover. Siga a conversa normalmente.')
        }
        if (currentIdx === targetIdx) return ok(`O lead já está em "${etapaName}".`)
        if (currentIdx > targetIdx) {
          return err('O lead já está numa etapa mais avançada do funil — não mova pra trás. Siga a conversa normalmente.')
        }
        await updateLeadStatus(leadId, stage.id, CRM_MAP.pipelineId)
        leadCache.delete(leadId)
        return ok(`Lead movido para "${etapaName}".`)
      }
      case 'preencher_qualificacao': {
        const campoName = String(input.campo || '')
        const valor = String(input.valor || '').trim()
        const field = CRM_MAP.leadFields.find(f => f.name === campoName)
        if (!field) return err(`Campo "${campoName}" não existe.`)
        if (!valor) return err('Valor vazio.')

        if (field.options) {
          // Match tolerante a caixa/acento; grava sempre o enum canônico
          const canonical = new Map(field.options.map(o => [normalize(o.value), o]))
          const vals = valor.split(',').map(v => v.trim()).filter(Boolean)
          const mapped: number[] = []
          const invalid: string[] = []
          for (const v of vals) {
            const c = canonical.get(normalize(v))
            if (c) mapped.push(c.id)
            else invalid.push(v)
          }
          if (invalid.length > 0) {
            return err(`Valor(es) inválido(s): ${invalid.join(', ')}. Opções válidas: ${field.options.map(o => o.value).join(' | ')}`)
          }
          let enumIds = field.multi ? mapped : mapped.slice(0, 1)
          if (field.multi) {
            // PATCH substitui os valores do campo — preserva o que já estava
            const lead = await getLeadCached(leadId)
            enumIds = [...new Set([...fieldEnumIds(lead, field.id), ...mapped])]
          }
          await updateLeadFields(leadId, [
            { field_id: field.id, values: enumIds.map(id => ({ enum_id: id })) },
          ])
        } else {
          await updateLeadFields(leadId, [
            { field_id: field.id, values: [{ value: valor }] },
          ])
        }
        leadCache.delete(leadId)
        return ok(`Campo "${campoName}" preenchido com "${valor}".`)
      }
      case 'escalar_para_humano': {
        // Põe a tag de humano e TIRA a de gate na mesma escrita: card com as
        // duas ao mesmo tempo faz o time ler "a IA está ativa" quando ela já
        // está calada. Uma escrita só = nunca existe o estado ambíguo.
        await swapLeadTags(leadId, [CONFIG.humanTag], CONFIG.gateTag ? [CONFIG.gateTag] : [])
        leadCache.delete(leadId)
        // Sai do fluxo = sai da fila NA MESMA VOLTA. O lib/agent.ts também faz
        // isso ao fim do turno; aqui é defesa em profundidade, pro caso de o
        // turno morrer entre a escalação e o fim do processamento.
        await clearFollowup(leadId)
        console.log(`[escalação] lead ${leadId}: ${String(input.motivo || '')} — tag "${CONFIG.humanTag}" aplicada, gate "${CONFIG.gateTag}" removida`)
        return ok(`Atendimento escalado — a tag "${CONFIG.humanTag}" foi adicionada e a tag da IA foi removida. Envie agora a despedida avisando que alguém do time vai assumir.`)
      }
      default:
        return err(`Tool desconhecida "${name}".`)
    }
  } catch (e) {
    return err(`Falha ao executar ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}
