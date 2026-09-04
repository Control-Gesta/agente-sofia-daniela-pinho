import { Redis } from '@upstash/redis'
import { CONFIG } from './config'

/**
 * Redis (Upstash) é o coração desta variante: histórico da conversa,
 * buffer/eleição, outbox do Salesbot e fila de followup.
 * Todas as chaves usam o prefixo "ak:" (agente-kommo) — permite dividir o
 * mesmo database com o agente GHL (prefixo "agente:") sem colisão.
 */
export const redis = new Redis({ url: CONFIG.upstashUrl, token: CONFIG.upstashToken })
