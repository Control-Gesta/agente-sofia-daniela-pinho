import fs from 'fs'
import path from 'path'
import OpenAI from 'openai'
import { CONFIG } from './config'
import type { ChatMsg } from './history'
import type { KommoLead } from './kommo'
import { TOOLS, runTool } from './tools'

/**
 * Cérebro do agente — OpenAI (GPT-5.4 Mini), não o Claude validado pelo
 * curso. Decisão do cliente (só tinha chave OpenAI, não Anthropic): trocar o
 * modelo aqui significa reescrever e retestar esta peça sem o histórico de
 * evals que o template original tem com Claude. Ver comum/ESCOLHA-LLM.md.
 *
 * A Sofia NUNCA responde em áudio (Desenho A/Salesbot não suporta voice note,
 * e o guia do cliente proíbe isso mesmo quando o paciente manda áudio) — por
 * isso, diferente do template original, não existe lógica de marcador
 * [AUDIO] aqui. Áudio do paciente chega já transcrito em texto (lib/stt.ts).
 */

const openai = new OpenAI({ apiKey: CONFIG.openaiApiKey })

let promptCache: string | null = null

function loadPromptTemplate(): string {
  if (promptCache) return promptCache
  const candidates = [
    path.join(process.cwd(), 'prompt.md'),
    path.join(__dirname, '..', 'prompt.md'),
    path.join(__dirname, '..', '..', 'prompt.md'),
  ]
  for (const p of candidates) {
    try {
      promptCache = fs.readFileSync(p, 'utf-8')
      return promptCache
    } catch { /* tenta o próximo */ }
  }
  throw new Error('prompt.md não encontrado no bundle')
}

/**
 * System em 2 mensagens: o template estático (prefixo idêntico em toda
 * chamada — a OpenAI cacheia automaticamente prefixos ≥1024 tokens) e o
 * contexto dinâmico (data/hora, lead) separado, senão o timestamp invalida
 * o cache a cada minuto.
 */
function buildSystem(lead: KommoLead): OpenAI.Chat.ChatCompletionMessageParam[] {
  const template = loadPromptTemplate().trim()
  const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'full', timeStyle: 'short' })
  const dynamic = [
    `# Contexto desta conversa`,
    `Data/hora atual: ${agora}`,
    `Nome do lead no CRM: ${lead.name || '(desconhecido)'}`,
    `Tags do lead: ${(lead._embedded?.tags || []).map(t => t.name).join(', ') || '(nenhuma)'}`,
  ].join('\n')

  return [
    { role: 'system', content: template },
    { role: 'system', content: dynamic },
  ]
}

/** Converte o histórico (Redis) em turns (user/assistant alternados, mesclando consecutivos). */
function toOpenAiMessages(msgs: ChatMsg[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  const turns: OpenAI.Chat.ChatCompletionMessageParam[] = []
  for (const m of msgs) {
    const role: 'user' | 'assistant' = m.dir === 'in' ? 'user' : 'assistant'
    const body = (m.text || '').trim()
    if (!body) continue
    const prev = turns[turns.length - 1]
    if (prev && prev.role === role && typeof prev.content === 'string') {
      prev.content = `${prev.content}\n${body}`
    } else {
      turns.push({ role, content: body })
    }
  }
  while (turns.length > 0 && turns[0].role !== 'user') turns.shift()
  while (turns.length > 0 && turns[turns.length - 1].role !== 'user') turns.pop()
  return turns
}

export interface AgentReply {
  parts: string[]
  toolsUsed: string[]
  /** Sofia nunca responde em voz (Desenho A não suporta) — sempre false. */
  voice: boolean
  voiceText: string
}

const MAX_STEPS = 6

/**
 * Quebra em parágrafos (linha em branco = separador). O limite aqui é só um
 * teto de segurança contra resposta descontrolada — no transport salesbot
 * (único usado neste projeto) os parágrafos são sempre rejuntados com "\n\n"
 * numa única mensagem, então um teto baixo só cortaria a pergunta final de
 * propósito sem nenhum ganho. Por isso o teto é generoso (8), não 3.
 */
function toParts(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean)
    .slice(0, 8)
}

async function callOpenAi(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  opts: { tools: boolean; maxTokens: number },
): Promise<OpenAI.Chat.ChatCompletion> {
  return openai.chat.completions.create({
    model: CONFIG.openaiModel,
    max_completion_tokens: opts.maxTokens,
    messages,
    ...(opts.tools ? { tools: TOOLS, tool_choice: 'auto' } : {}),
  })
}

/**
 * Followup: gera UMA mensagem de reengajamento a partir do histórico
 * completo. Sem tools: followup só fala, não mexe no CRM.
 * (Não usado enquanto o follow-up automático estiver desligado — ver README
 * do projeto — mas mantido pronto pra quando a clínica quiser ligar.)
 */
export async function generateFollowup(lead: KommoLead, history: ChatMsg[], cadencia: number): Promise<string | null> {
  const turns = toOpenAiMessages(history)
  turns.push({
    role: 'user',
    content: `[INSTRUÇÃO DO SISTEMA — o paciente NÃO respondeu sua última mensagem] Gere a mensagem de FOLLOWUP de cadência ${cadencia} seguindo as regras da seção "Followup" do seu prompt. Responda APENAS com o texto da mensagem de WhatsApp, nada mais.`,
  })

  const response = await callOpenAi([...buildSystem(lead), ...turns], { tools: false, maxTokens: 1024 })
  const text = (response.choices[0]?.message?.content || '').trim()
  if (!text) return null
  return text.slice(0, 500)
}

export async function generateReply(lead: KommoLead, history: ChatMsg[]): Promise<AgentReply | null> {
  const historyTurns = toOpenAiMessages(history)
  if (historyTurns.length === 0) return null

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [...buildSystem(lead), ...historyTurns]
  const toolsUsed: string[] = []
  let lastPartialText = ''

  for (let step = 0; step < MAX_STEPS; step++) {
    let response = await callOpenAi(messages, { tools: true, maxTokens: 2048 })
    let choice = response.choices[0]

    if (choice.finish_reason === 'length') {
      console.warn(`[llm] finish_reason=length no step ${step} — retry com teto maior`)
      response = await callOpenAi(messages, { tools: true, maxTokens: 4096 })
      choice = response.choices[0]
      if (choice.finish_reason === 'length') {
        console.error('[llm] length de novo — abortando com o texto que houver')
        const partial = (choice.message?.content || '').trim()
        if (!partial) return null
        return { parts: toParts(partial), toolsUsed, voice: false, voiceText: '' }
      }
    }

    const toolCalls = choice.message?.tool_calls
    if (choice.finish_reason === 'tool_calls' && toolCalls && toolCalls.length > 0) {
      if (choice.message.content) lastPartialText = choice.message.content

      messages.push(choice.message)
      for (const call of toolCalls) {
        if (call.type !== 'function') continue
        toolsUsed.push(call.function.name)
        let input: Record<string, unknown> = {}
        try { input = JSON.parse(call.function.arguments || '{}') } catch { /* args inválidos: tool trata */ }
        const outcome = await runTool(lead.id, call.function.name, input)
        if (outcome.isError) {
          console.error(`[tool:${call.function.name}] erro (lead ${lead.id}): ${outcome.content}`)
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: outcome.content || '(sem retorno)',
        })
      }
      continue
    }

    const text = (choice.message?.content || '').trim()
    if (!text) return null
    return { parts: toParts(text), toolsUsed, voice: false, voiceText: '' }
  }

  // MAX_STEPS estourou com tools já executadas (efeitos commitados no CRM).
  // Chamada final SEM tools força uma resposta em texto pro lead.
  console.warn(`[llm] MAX_STEPS atingido (lead ${lead.id}) — forçando resposta final sem tools`)
  const finalResponse = await callOpenAi(messages, { tools: false, maxTokens: 2048 })
  const finalText = (finalResponse.choices[0]?.message?.content || '').trim() || lastPartialText
  if (!finalText) return null
  return { parts: toParts(finalText), toolsUsed, voice: false, voiceText: '' }
}
