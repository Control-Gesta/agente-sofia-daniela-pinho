/**
 * MAPA DE CRM (Kommo) — a única coisa que muda de cliente pra cliente.
 *
 * Conta: dradanielapinho.kommo.com (account_id 29922050). Funil escolhido
 * com a cliente em 20/08/2026, após correção de rota: "Funil de vendas"
 * (id 5015531, o funil PRINCIPAL da conta — não confundir com o funil
 * "Vendas", id 10703448, que foi a escolha inicial e foi descartada). É
 * onde o número oficial da Sofia cria os leads hoje.
 *
 * ⚠️ Esse funil tem dezenas de etapas de pós-procedimento por tipo de
 * tratamento (Botox, Lipo, Sculptra…) que NÃO são da alçada da Sofia — elas
 * só estão listadas no `stageOrder` pra o guard anti-retrocesso não ficar
 * cego. A Sofia só conhece e move as 3 etapas em `stages[]`.
 *
 * Desenho da Sofia: SEM agendamento (ela não marca consulta, não mexe em
 * calendário, não confirma Pix — isso é do time humano) e, por decisão da
 * cliente, SEM follow-up automático por enquanto (o bloco `followup` fica
 * pronto mas dormente: sem CRON_SECRET e sem o cron no vercel.json, ele
 * nunca dispara sozinho).
 *
 * ⚠️ Rodar GET /api/validate?secret=... depois de QUALQUER mexida no funil —
 * é ele que denuncia o drift antes de virar perda silenciosa de dado.
 */

export interface StageRule {
  /** status_id no Kommo */
  id: number
  /** nome real do status no Kommo (validate compara) */
  name: string
  /** instrução que o modelo vê: quando mover o lead pra cá */
  quando: string
}

export interface LeadFieldRule {
  /** field_id no Kommo */
  id: number
  /** nome que o MODELO vê (pode ser mais limpo que o nome real) */
  name: string
  /** nome real do campo no Kommo (validate compara) */
  kommoName: string
  type: 'text' | 'textarea' | 'select' | 'multiselect' | 'numeric'
  /** instrução que o modelo vê: quando preencher */
  quando: string
  /** select/multiselect: opções válidas com enum_id do Kommo */
  options?: Array<{ id: number; value: string }>
  multi?: boolean
}

export const CRM_MAP = {
  pipelineId: 5015531,
  pipelineName: 'Funil de vendas',

  // Janela em que o HUMANO atende (recepção da clínica) — a Sofia fica calada
  // nesse horário de propósito, pra não conflitar com quem já está
  // respondendo. Fora disso (noite, fim de semana, feriado) ela assume.
  // Decisão da cliente em 20/08/2026. `feriados` é uma lista solta de datas
  // (YYYY-MM-DD, fuso America/Sao_Paulo) — são só os feriados NACIONAIS de
  // 2026; a clínica deve revisar todo ano e acrescentar feriados municipais
  // de Belo Horizonte ou pontos facultativos que ela observe.
  atendimentoHumano: {
    timezone: 'America/Sao_Paulo',
    diasSemana: [1, 2, 3, 4, 5], // seg-sex — sáb/dom são sempre da Sofia
    inicioHora: 8,
    fimHora: 18,
    feriados: [
      '2026-01-01', // Confraternização Universal
      '2026-02-16', // Carnaval (segunda)
      '2026-02-17', // Carnaval (terça)
      '2026-04-03', // Sexta-feira Santa
      '2026-04-21', // Tiradentes
      '2026-05-01', // Dia do Trabalho
      '2026-06-04', // Corpus Christi
      '2026-09-07', // Independência
      '2026-10-12', // Nossa Senhora Aparecida
      '2026-11-02', // Finados
      '2026-11-15', // Proclamação da República
      '2026-12-25', // Natal
    ],
  },

  // Campo textarea no lead onde o agente deposita a resposta (o Salesbot de
  // envio lê daqui; o /api/salesbot usa o outbox do Redis). Criado ao vivo
  // via API em 20/08/2026 (não existia na conta) — é campo do LEAD, então
  // vale pra qualquer funil, não precisou recriar ao trocar de funil.
  respostaFieldId: 876625, // "Resposta IA (agente)"

  /**
   * PRIMEIRA resposta de qualquer conversa — enviada pelo CÓDIGO, não pelo
   * modelo (lib/agent.ts).
   *
   * CICATRIZ (produção, 03/09/2026): quando a primeira mensagem do paciente
   * já vinha com pedido ("gostaria de agendar", "quero saber da lipo de
   * papada"), o modelo respondia o pedido e PULAVA a apresentação — o
   * paciente não sabia que estava falando com uma secretária virtual. A
   * instrução existia no prompt e não foi obedecida. Como o texto é fixo,
   * ele virou código: agora é impossível pular.
   *
   * A pergunta do paciente não se perde: ela fica no histórico e é
   * respondida na troca seguinte, já com a apresentação feita.
   */
  mensagemApresentacao: [
    'Oi, tudo bem? Eu sou a Sofia, secretária virtual da Dra. Daniela Pinho.',
    'Estou atendendo fora do horário comercial da nossa equipe, mas posso te ajudar agora: tirar suas dúvidas iniciais e já ir conduzindo seu atendimento.',
    'Você pode me mandar mensagem por texto ou por áudio, como preferir.',
    'Quando for necessário, nossa equipe humana continua e finaliza seu atendimento no horário comercial.',
    'Antes de começar, qual é o seu nome?',
  ].join('\n\n'),

  /**
   * QUANDO a Sofia pode ENTRAR num lead sozinha (auto-tag).
   *
   * CICATRIZ (produção, 03/09/2026): escopar o auto-tag só por FUNIL não
   * bastou — a Sofia se apresentou pra um FORNECEDOR antigo parado 307 dias
   * na etapa "fornecedores", e para pacientes que já eram da casa. Funil não
   * distingue "primeiro contato" de "relação antiga"; quem distingue é a
   * ETAPA onde o lead está e a IDADE dele.
   *
   * Regra: ela só entra em lead que está numa etapa de ENTRADA **e** foi
   * criado há pouco tempo. Isso é avaliado só no momento de entrar — depois
   * de tagueado, ela continua a conversa normalmente (paciente que responde
   * dois dias depois não é abandonado).
   */
  entradaAutomatica: {
    // Etapas onde um lead REALMENTE novo aparece. Qualquer outra etapa
    // (fornecedores, conhecidos, ANTIGO PACIENTE, Consulta Agendada, FEZ
    // PIX, Retorno Agendado, pós-procedimento…) significa relação existente
    // e a Sofia NÃO entra.
    stages: [
      45192155, // Etapa de leads de entrada
      64427048, // conversa aberta
    ],
    // Idade máxima do lead pra ser considerado "novo". Pega o caso do lead
    // antigo abandonado numa etapa de entrada que volta a escrever meses
    // depois — esse é atendimento humano, não primeiro contato.
    idadeMaximaHoras: 48,
  },

  // Followup automático — DORMENTE por decisão da cliente (sem CRON_SECRET e
  // sem cron no vercel.json, isto nunca dispara sozinho). Deixado pronto pra
  // quando ela quiser ligar: só criar o campo select "Follow-up" no Kommo,
  // preencher os enum_id abaixo, configurar CRON_SECRET e devolver o cron no
  // vercel.json.
  followup: {
    intervalosHoras: [12, 24, 48, 72], // horas de silêncio antes de cada cadência (1..4)
    janela: { inicioHora: 9, fimHora: 18, diasSemana: [1, 2, 3, 4, 5] }, // seg-sex, 9h-18h (horário da clínica)
    timezone: 'America/Sao_Paulo',
    // 143 = "Venda perdida" — id fixo do Kommo em qualquer conta
    aoEsgotar: { tag: 'ia-followup-esgotado', statusId: 143 },
    campoCadencia: {
      id: 0, // PREENCHER (só se/quando ligar o follow-up): campo select "Follow-up"
      options: [
        { id: 0, value: 'Follow-up 1' },
        { id: 0, value: 'Follow-up 2' },
        { id: 0, value: 'Follow-up 3' },
        { id: 0, value: 'Follow-up 4' },
      ],
    },
    maxPorRodada: 60,
    concorrencia: 4,
  },

  // Alçada da Sofia dentro do "Funil de vendas": do primeiro contato até o
  // paciente manifestar intenção de agendar (ou pedir ligação, ou confirmar
  // interesse em 30 dias). Dali em diante é escalar_para_humano: o time
  // assume e finaliza. A Sofia NUNCA move pra "Venda ganha", nem toca nas
  // dezenas de etapas de pós-procedimento (Botox, Lipo, Sculptra…) que vêm
  // depois. Revisado em 28/08/2026 conforme documento de correções da
  // cliente: "PACIENTE COM DEMANDA" saiu da alçada (não faz mais parte do
  // fluxo oficial) e "Agendamento" entrou (é pra onde vai quem manifesta
  // interesse em marcar consulta, independente de ser lead de 30 dias).
  stages: [
    {
      id: 64427048,
      name: 'conversa aberta',
      quando: 'A conversa engatou de verdade: o paciente respondeu à mensagem inicial da Sofia e está interagindo.',
    },
    {
      id: 101118216,
      name: 'Proximos 30 dias',
      quando: 'O paciente respondeu que tem intenção de realizar o procedimento nos próximos 30 dias (lead prioritário/quente).',
    },
    {
      id: 99393724,
      name: 'Agendamento',
      quando: 'O paciente manifestou intenção de marcar uma consulta (ex: "quero marcar", "gostaria de agendar", "como faço pra marcar?"), em qualquer momento da conversa — não precisa ter respondido "sim" nos 30 dias antes.',
    },
    {
      id: 99393720,
      name: 'Ligação',
      quando: 'O paciente pediu pra falar por ligação em vez de continuar pelo WhatsApp.',
    },
  ] as StageRule[],

  // ORDEM REAL do funil "Funil de vendas" (campo `sort` do Kommo, coletado
  // ao vivo em 20/08/2026). Usada pelo guard anti-retrocesso: a Sofia só
  // move ADIANTE. Lista TODOS os status do funil, inclusive as dezenas que
  // ela não usa (pós-procedimento por tipo de tratamento, cobrança, etc.) —
  // status faltando aqui = guard furado.
  stageOrder: [
    45192155,  // Etapa de leads de entrada
    64427048,  // conversa aberta
    99393720,  // Ligação
    99393724,  // Agendamento
    101118216, // Proximos 30 dias
    100915320, // Atendimento 1
    100915324, // Atendimento 2
    80678872,  // tarefas
    92246460,  // PACIENTE COM DEMANDA
    87501980,  // AGENDOU LIFTERA
    87501984,  // AGENDOU SCULPTRA
    87501988,  // AGENDOU SYLFIRM
    80265284,  // NMLIFTERA
    80265288,  // NMSYLFIRM
    64409844,  // NmPBOTOX
    64410404,  // NmPREENCHIMENTO
    64410408,  // NmSCULPTRA
    107626416, // NMLIFTINGFACIAL
    64410412,  // NmABDOME
    64410416,  // mnLIPo
    64410420,  // NmMAMAREDUTORA
    64410424,  // NmPROTESE/GORDUR
    64410428,  // NmRINo
    64410432,  // NmBLEFARO
    64410436,  // NmNINFO
    64410440,  // Nmlobulo
    64425892,  // Nmotoplastia
    64410444,  // NmPLIPOPAPADA
    45806519,  // Não Marcou GERAL
    45192158,  // não atendeu
    45986210,  // cobrança 24 horas
    45558782,  // conhecidos
    45559106,  // fornecedores
    57393728,  // ANTIGO PACIENTE
    107700616, // ALTA CIRÚRGICA
    86438252,  // NÃO QUALIFICADOS
    45868508,  // Não quer contato
    86675480,  // Retorno Agendado
    45558716,  // PRE-MARCAÇÃO(FALTA PGTO)
    45559109,  // FEZ PIX
    86679960,  // Consulta Agendada
    142,       // Venda ganha (fixo do Kommo) — do time
    143,       // Venda perdida (fixo do Kommo)
  ],

  // Campos de qualificação no LEAD (Kommo é lead-cêntrico — sem opportunity).
  // São campos do LEAD, não do funil — continuam valendo depois da troca.
  leadFields: [
    {
      id: 873399,
      name: 'Procedimento de interesse',
      kommoName: 'Procedimento',
      type: 'text',
      quando: 'o paciente disser qual procedimento ou tratamento tem interesse (ex: botox, preenchimento labial, lipo, mamoplastia, ninfoplastia)',
    },
    {
      id: 876627,
      name: 'Resumo da conversa',
      kommoName: 'Resumo da conversa',
      type: 'textarea',
      quando: 'a conversa tiver um marco relevante (qualificou, concordou com a política comercial, esfriou): grave um resumo curto de 2-3 linhas (o que ele quer, estágio, próximo passo)',
    },
  ] as LeadFieldRule[],
}
