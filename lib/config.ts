function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Env var obrigatória ausente: ${name}`)
  return v
}

/**
 * Variante KOMMO do agente: diferente do GHL, o Kommo não devolve o
 * transcript da conversa pela API — o histórico vive no Redis (obrigatório)
 * e o envio é indireto (Salesbot ou uazapi). Ver README.
 */
export const CONFIG = {
  kommoDomain: required('KOMMO_DOMAIN').replace(/\/+$/, ''),
  kommoToken: required('KOMMO_TOKEN'),
  kommoAccountId: required('KOMMO_ACCOUNT_ID'),
  // Salesbot de ENVIO (bloco widget-request → /api/salesbot, ou bloco que
  // envia o campo "Resposta IA (agente)"). Obrigatório no transport salesbot.
  kommoBotId: Number(process.env.KOMMO_BOT_ID || 0),

  // 'salesbot' = Desenho A (WhatsApp oficial do Kommo, sem voz)
  // 'uazapi'   = Desenho B (WhatsApp na uazapi: voz + multi-mensagem)
  transport: (process.env.TRANSPORT || 'salesbot') as 'salesbot' | 'uazapi',
  uazapiBaseUrl: (process.env.UAZAPI_BASE_URL || '').replace(/\/+$/, ''),
  uazapiToken: process.env.UAZAPI_TOKEN || '',
  // Número DEDICADO da IA: mensagem de desconhecido cria lead automático
  // (com a tag do gate). Em número COMPARTILHADO (ex: suporte) deixe '0' —
  // senão todo cliente de suporte vira lead atendido pela IA.
  uazapiAutoCreateLead: process.env.UAZAPI_AUTO_CREATE_LEAD === '1',
  // A uazapi aceita SÓ 1 webhook por instância. Quando outro sistema também
  // precisa das mensagens (ex: um inbox/chat interno no mesmo número), nosso
  // /api/uazapi retransmite o payload cru pra esta URL (fire-and-forget).
  uazapiRelayUrl: process.env.UAZAPI_RELAY_URL || '',

  // Cérebro do agente: OpenAI em vez do Claude validado pelo curso — decisão
  // do cliente (só tinha chave OpenAI). Mesma chave serve pro ouvido (STT).
  openaiApiKey: required('OPENAI_API_KEY'),
  openaiModel: process.env.OPENAI_MODEL || 'gpt-5.4-mini',
  webhookSecret: required('WEBHOOK_SECRET'),
  debounceSeconds: Number(process.env.DEBOUNCE_SECONDS || 10),

  // Tag no LEAD que desliga o agente (humano assumiu)
  humanTag: (process.env.HUMAN_TAG || 'atendimento-humano').toLowerCase(),
  // Tag no LEAD que LIGA o agente (rampagem gradual). Vazio = responde todos.
  gateTag: (process.env.GATE_TAG ?? 'iav').toLowerCase(),

  // Redis é OBRIGATÓRIO nesta variante: é o dono do histórico da conversa
  upstashUrl: required('UPSTASH_REDIS_REST_URL'),
  upstashToken: required('UPSTASH_REDIS_REST_TOKEN'),

  // Voz (ElevenLabs) — só tem efeito com TRANSPORT=uazapi (não é o caso aqui:
  // a Sofia nunca envia áudio, só recebe e transcreve — ver lib/stt.ts)
  elevenApiKey: process.env.ELEVENLABS_API_KEY || '',
  elevenVoiceId: process.env.ELEVENLABS_VOICE_ID || '',

  // Interruptor de teste: com '1', ignora o horário de atendimento humano
  // (lib/schedule.ts) e a Sofia responde a qualquer hora. Usar só durante
  // testes — REMOVER (ou voltar pra '0') antes de qualquer rampagem real,
  // senão ela conversa por cima do time em horário comercial.
  ignorarHorario: process.env.IGNORAR_HORARIO === '1',

  // Freio de mão total: com '1', o agente não faz NADA — nem auto-tag, nem
  // responde, nem mexe em tag/etapa/campo. Pra quando o conteúdo (prompt,
  // funil, campos) está em alteração e não pode falar com paciente real
  // nesse meio-tempo. Diferente do GATE_TAG: isso pausa TODOS os leads,
  // inclusive os já tagueados antes.
  agentePausado: process.env.AGENTE_PAUSADO === '1',

  // Auto-tag: com '1', todo lead novo do funil ganha a GATE_TAG sozinho (modo
  // produção aberta). Com '0' (padrão), só responde quem foi tagueado à mão —
  // é o modo rampagem/teste. Ligar isso é o que faz a IA falar com a base
  // inteira, então é decisão explícita, não default.
  autoTag: process.env.AUTO_TAG === '1',

  // Allowlist de teste: telefones (só dígitos, separados por vírgula) que a
  // Sofia pode atender. Vazio = sem restrição de telefone (produção).
  // Preenchido = trava dura: qualquer outro número é ignorado mesmo que o
  // lead tenha a GATE_TAG. Comparação pelos últimos 8 dígitos, pra não
  // depender de +55, DDD ou do 9º dígito estarem iguais.
  testPhones: (process.env.TEST_PHONES || '')
    .split(',')
    .map(p => p.replace(/\D+/g, ''))
    .filter(p => p.length >= 8)
    .map(p => p.slice(-8)),
}
