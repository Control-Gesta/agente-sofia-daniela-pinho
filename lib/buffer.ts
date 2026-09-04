import crypto from 'crypto'
import { CONFIG } from './config'
import { redis } from './redis'
import { sleep } from './kommo'

/**
 * Buffer/debounce + eleição de líder (Redis obrigatório nesta variante):
 *  - token "last webhook wins": só o webhook mais recente processa a rajada
 *  - lock com dono (compare-and-delete) — retry de webhook nunca duplica
 *  - rate limit por lead (proteção de custo E de loop)
 */

const LOCK_TTL = 180 // segundos

export interface Claim {
  proceed: boolean
  reason: string
  lockOwner?: string
}

export async function debounceAndClaim(leadId: number, webhookId: string): Promise<Claim> {
  // Rate limit: 10 processamentos/min por lead
  const rl = await redis.incr(`ak:rl:${leadId}`)
  if (rl === 1) await redis.expire(`ak:rl:${leadId}`, 60)
  if (rl > 10) return { proceed: false, reason: 'rate limit' }

  const tokenKey = `ak:token:${leadId}`
  await redis.set(tokenKey, webhookId, { ex: 600 })

  await sleep(CONFIG.debounceSeconds * 1000)

  const current = await redis.get<string>(tokenKey)
  if (current !== webhookId) {
    return { proceed: false, reason: 'webhook mais novo assumiu' }
  }

  const lockOwner = crypto.randomUUID()
  const locked = await redis.set(`ak:lock:${leadId}`, lockOwner, { nx: true, ex: LOCK_TTL })
  if (locked !== 'OK') {
    // Quem segura o lock re-checa o token ao terminar e pegará nossas msgs
    return { proceed: false, reason: 'lock ocupado (dono re-checa ao final)' }
  }
  return { proceed: true, reason: 'ok', lockOwner }
}

/** Release só se ainda formos o dono (compare-and-delete atômico). */
export async function releaseLock(leadId: number, lockOwner?: string): Promise<void> {
  if (!lockOwner) return
  await redis.eval(
    `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
    [`ak:lock:${leadId}`],
    [lockOwner],
  )
}

/** Renova o TTL do lock (gerações longas / múltiplos rounds). */
export async function renewLock(leadId: number, lockOwner: string): Promise<void> {
  await redis.eval(
    `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("expire", KEYS[1], ${LOCK_TTL}) else return 0 end`,
    [`ak:lock:${leadId}`],
    [lockOwner],
  )
}

/** Token atual — se mudou durante a geração, chegou msg nova (contexto obsoleto). */
export async function currentToken(leadId: number): Promise<string | null> {
  return redis.get<string>(`ak:token:${leadId}`)
}

/** O dono do lock adota o webhook mais novo antes de reprocessar. */
export async function adoptToken(leadId: number, webhookId: string): Promise<void> {
  await redis.set(`ak:token:${leadId}`, webhookId, { ex: 600 })
}
