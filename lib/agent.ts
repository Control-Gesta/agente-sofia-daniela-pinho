import crypto from 'crypto'
import { adoptToken, currentToken, debounceAndClaim, releaseLock, renewLock } from './buffer'
import { CONFIG } from './config'
import { generateReply } from './llm'
import { clearFollowup, scheduleSilenceCheck } from './followup'
import { CRM_MAP } from './crm-map'
import { alreadyAnswered, appendMessage, clearHistory, getHistory, lastInbound, markAnswered, type Channel } from './history'
import { addLeadTags, getLead, getLeadPhone, type KommoLead } from './kommo'
import { dentroDoHorarioHumano } from './schedule'
import { sendReply } from './transport'

/**
 * Core de processamento — compartilhado pelos dois caminhos de entrada
 * (webhook add_message do Kommo e webhook da uazapi). A mensagem inbound JÁ
 * foi registrada no histórico pelo handler antes de chamar aqui.
 */

const MAX_ROUNDS = 3

/**
 * Diz por que este lead NÃO é um primeiro contato — ou null se ele é.
 * Fail-closed: qualquer dúvida (funil errado, etapa fora da lista, idade
 * desconhecida) devolve motivo e a Sofia não entra. É mais barato deixar um
 * paciente novo esperando a equipe do que se apresentar pra um fornecedor.
 */
function motivoParaNaoEntrar(lead: KommoLead): string | null {
  const regra = CRM_MAP.entradaAutomatica
  if (lead.pipeline_id !== CRM_MAP.pipelineId) return `outro funil (${lead.pipeline_id})`
  if (!regra.stages.includes(lead.status_id)) return `etapa ${lead.status_id} não é de entrada`
  if (!lead.created_at) return 'sem data de criação'
  const horas = (Date.now() / 1000 - lead.created_at) / 3600
  if (horas > regra.idadeMaximaHoras) return `lead tem ${Math.round(horas / 24)} dia(s), não é novo`
  return null
}

export async function processLead(leadId: number, webhookId: string, opts?: { phoneHint?: string; via?: Channel }): Promise<void> {
  if (CONFIG.agentePausado) {
    console.log(`[agente] AGENTE_PAUSADO=1 — ignorando lead ${leadId} por completo`)
    return
  }
  let lockOwner: string | undefined
  const t0 = Date.now()
  let nomeLead = ''
  try {
    const lead = await getLead(leadId)
    nomeLead = lead.name || `lead ${leadId}`
    let tags = (lead._embedded?.tags || []).map(t => t.name.toLowerCase())

    if (tags.includes(CONFIG.humanTag)) {
      console.log(`[agente] lead ${leadId} (${nomeLead}) tem tag "${CONFIG.humanTag}" — não respondo`)
      return
    }

    // Allowlist de teste (fail-closed): com TEST_PHONES preenchida, só
    // atende os telefones listados — qualquer outro é ignorado mesmo tendo a
    // GATE_TAG. É o que permite testar sem falar com paciente real, já que o
    // webhook add_message NÃO informa por qual número a mensagem chegou
    // (então filtrar "quem mandou" é o mais próximo de filtrar "pra qual
    // número mandou" que a API do Kommo permite).
    if (CONFIG.testPhones.length > 0) {
      const phone = (await getLeadPhone(lead)) || ''
      const tail = phone.replace(/\D+/g, '').slice(-8)
      if (!tail || !CONFIG.testPhones.includes(tail)) {
        console.log(`[agente] lead ${leadId} fora da allowlist de teste (telefone …${tail || 'desconhecido'}) — ignorando`)
        return
      }
      console.log(`[agente] lead ${leadId} liberado pela allowlist de teste (…${tail})`)
    }

    // Auto-tag: com AUTO_TAG=1, lead NOVO que escreve no funil da Sofia ganha
    // a tag de gate sozinho. Com AUTO_TAG=0 (modo rampagem/teste) isso não
    // acontece: só responde lead tagueado à mão.
    //
    // "NOVO" = etapa de entrada + criado há pouco (CRM_MAP.entradaAutomatica).
    // Sem esses dois testes, a Sofia se apresenta pra fornecedor antigo e pra
    // paciente que já é da casa — aconteceu em produção em 03/09/2026.
    // O teste vale só pra ENTRAR: lead já tagueado segue sendo atendido.
    if (CONFIG.autoTag && CONFIG.gateTag && !tags.includes(CONFIG.gateTag)) {
      const motivo = motivoParaNaoEntrar(lead)
      if (motivo) {
        console.log(`[agente] lead ${leadId} (${nomeLead}) NÃO é primeiro contato (${motivo}) — não entro`)
        return
      }
      try {
        await addLeadTags(leadId, [CONFIG.gateTag])
        tags = [...tags, CONFIG.gateTag]
        console.log(`[agente] lead ${leadId} (${nomeLead}) — tag de gate "${CONFIG.gateTag}" aplicada automaticamente (lead novo em ${CRM_MAP.pipelineName})`)
      } catch (e) {
        console.error(`[agente] falha ao auto-taguear lead ${leadId}:`, e)
      }
    }

    // Gate de rampagem: com GATE_TAG preenchida, só responde quem tem a tag
    // (vazia = responde todos). O log fica de propósito — é ele que explica o
    // silêncio do agente quando você testa com um lead sem a tag.
    if (CONFIG.gateTag && !tags.includes(CONFIG.gateTag)) {
      console.log(`[agente] lead ${leadId} sem tag de gate "${CONFIG.gateTag}" — ignorando`)
      return
    }

    // A Sofia só atende fora do horário em que a recepção humana está na
    // clínica (seg-sex 8h-18h, exceto feriado) — decisão da cliente. Dentro
    // desse horário ela fica calada de propósito, quem responde é o time.
    // IGNORAR_HORARIO=1 desliga essa checagem pra período de teste.
    if (!CONFIG.ignorarHorario && dentroDoHorarioHumano()) {
      console.log(`[agente] lead ${leadId} dentro do horário de atendimento humano — não respondo`)
      return
    }

    const claim = await debounceAndClaim(leadId, webhookId)
    console.log(`[debounce] lead=${leadId} proceed=${claim.proceed} (${claim.reason})`)
    if (!claim.proceed) return
    lockOwner = claim.lockOwner

    let myToken = webhookId

    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (lockOwner) await renewLock(leadId, lockOwner)

      // Histórico fresco a cada round (inclui msgs que chegaram durante geração anterior)
      const history = await getHistory(leadId)
      const target = lastInbound(history)
      if (!target) {
        console.log(`[agente] sem inbound pra responder (lead ${leadId})`)
        return
      }

      // Idempotência: retry tardio do mesmo webhook não responde de novo
      if (await alreadyAnswered(leadId, target.id)) {
        console.log(`[agente] inbound ${target.id} já respondida — nada a fazer`)
        return
      }

      // Comando de teste (só pra quem já tem a tag de gate, então não afeta
      // paciente real): "reset" apaga a memória do lead e a fila de followup
      // — a próxima mensagem volta a ser tratada como primeiro contato, sem
      // precisar criar um lead novo pra cada rodada de teste.
      if (target.text.trim().toLowerCase() === 'reset') {
        await clearHistory(leadId)
        await clearFollowup(leadId)
        await markAnswered(leadId, target.id)
        const msg = 'Conversa reiniciada. Pode mandar a próxima mensagem como se fosse o primeiro contato.'
        const sent = await sendReply(lead, [msg], { voice: false, voiceText: '', phoneHint: opts?.phoneHint, via: opts?.via })
        console.log(`[agente] lead ${leadId} (${nomeLead}) — histórico resetado via comando "reset" (${sent.detail})`)
        return
      }

      // PRIMEIRA resposta da conversa = apresentação fixa, direto do código.
      // Não passa pelo modelo de propósito: ele pulava a apresentação quando
      // a primeira mensagem do paciente já trazia um pedido (ver cicatriz em
      // CRM_MAP.mensagemApresentacao). A dúvida dele continua no histórico e
      // é respondida na próxima troca.
      if (!history.some(m => m.dir === 'out')) {
        const apresentacao = CRM_MAP.mensagemApresentacao
        const sent = await sendReply(lead, [apresentacao], {
          voice: false, voiceText: '', phoneHint: opts?.phoneHint, via: opts?.via,
        })
        await appendMessage(leadId, {
          id: crypto.randomUUID(), dir: 'out', text: apresentacao, ts: Date.now(),
        })
        await markAnswered(leadId, target.id)
        console.log(`[agente] lead ${leadId} (${nomeLead}) — apresentação fixa enviada (${sent.detail})`)
        return
      }

      const reply = await generateReply(lead, history)
      if (!reply || reply.parts.length === 0) {
        console.error(`[agente] SEM resposta gerada para lead ${leadId} — verificar logs do llm`)
        return
      }

      // A decisão do CANAL é determinística do código (o modelo decide só o
      // conteúdo): áudio responde áudio, texto responde texto. O marcador do
      // modelo vale apenas quando o lead PEDIU áudio por escrito.
      const audioTurn = /^\[áudio do lead\]/i.test(target.text)
      const pediuAudio = !audioTurn && /[aá]udio|\bvoz\b/i.test(target.text)
      if (!reply.voice && audioTurn) {
        const vt = reply.voiceText || reply.parts.join(' ')
        if (vt && vt.length <= 500 && !/https?:\/\/|www\./i.test(vt)) {
          console.log('[voz] turno de áudio sem [AUDIO] do modelo — forçando voice note')
          reply.voice = true
          reply.voiceText = vt
        }
      } else if (reply.voice && !audioTurn && !pediuAudio) {
        console.log('[voz] turno de TEXTO com [AUDIO] do modelo — derrubando pra texto')
        reply.voice = false
      }

      // Chegou msg nova durante a geração? Contexto obsoleto → reprocessa
      const tok = await currentToken(leadId)
      if (tok && tok !== myToken) {
        console.log(`[agente] msg nova durante geração — round ${round + 1} com contexto atualizado`)
        myToken = tok
        await adoptToken(leadId, myToken)
        continue
      }

      const sent = await sendReply(lead, reply.parts, {
        voice: reply.voice,
        voiceText: reply.voiceText,
        phoneHint: opts?.phoneHint,
        via: opts?.via,
      })

      // Registro fiel do que saiu (voz registra o texto falado)
      await appendMessage(leadId, {
        id: crypto.randomUUID(),
        dir: 'out',
        text: sent.voice ? reply.voiceText : reply.parts.join('\n\n'),
        ts: Date.now(),
      })

      await markAnswered(leadId, target.id)
      // Lead respondeu e foi respondido: ciclo de followup reinicia do zero.
      // EXCEÇÃO: se a IA acabou de entregar o lead pro humano, reagendar aqui
      // devolveria pra fila quem acabou de sair do fluxo. Toda ação que tira o
      // lead do fluxo tem que tirá-lo da fila NA MESMA VOLTA.
      if (reply.toolsUsed.includes('escalar_para_humano')) await clearFollowup(leadId)
      else await scheduleSilenceCheck(leadId, 0)
      // Log nativo da Vercel é o painel do agente: leia em `vercel logs`
      console.log(
        `[agente] respondi lead ${leadId} (${nomeLead}) em ${Date.now() - t0}ms — ` +
        `${sent.detail}, voz=${sent.voice}, tools: ${reply.toolsUsed.join(',') || 'nenhuma'}`,
      )
      return
    }
    console.warn(`[agente] MAX_ROUNDS atingido (lead ${leadId}) — lead muito rápido, próximo webhook cuida`)
  } catch (e) {
    console.error(`[agente] erro processando lead ${leadId} (${nomeLead || leadId}) após ${Date.now() - t0}ms:`, e)
  } finally {
    await releaseLock(leadId, lockOwner)
  }
}
