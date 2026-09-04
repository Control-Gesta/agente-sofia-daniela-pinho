import { CONFIG } from './config'

/**
 * Resposta por voz: ElevenLabs Flash v2.5 gera ogg/opus — o ÚNICO formato que
 * o WhatsApp renderiza como voice note (bolinha + waveform, regra da Meta).
 * `output_format=opus_48000_64` sai pronto, ZERO conversão.
 *
 * Nesta variante a voz SÓ funciona com TRANSPORT=uazapi (o Salesbot do Kommo
 * não envia voice note). Com transport salesbot, o pipeline cai pra texto.
 */

const EL_BASE = 'https://api.elevenlabs.io/v1'

export const VOICE_MAX_CHARS = 800

/** Chaves de voz presentes (o transport da VEZ decide se dá pra usar — voz só sai pelo canal uazapi). */
export function hasVoiceKeys(): boolean {
  return !!(CONFIG.elevenApiKey && CONFIG.elevenVoiceId)
}

export async function synthesizeOpus(text: string): Promise<Buffer> {
  const res = await fetch(
    `${EL_BASE}/text-to-speech/${CONFIG.elevenVoiceId}?output_format=opus_48000_64`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': CONFIG.elevenApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_flash_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    },
  )
  if (!res.ok) {
    throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

/**
 * Sintetiza e devolve o áudio como base64 (a uazapi aceita base64/data URI
 * no campo file). Retorna null se a voz não puder ser gerada — o chamador
 * cai pra texto (lead nunca fica sem resposta).
 */
export async function textToVoiceBase64(text: string): Promise<string | null> {
  if (!hasVoiceKeys()) return null
  const clean = text.trim()
  if (!clean || clean.length > VOICE_MAX_CHARS) return null
  // Link NUNCA vai em áudio: link falado não dá pra clicar. O prompt.md já
  // proíbe — esta checagem é a defesa em profundidade (o modelo esquece)
  if (/https?:\/\/|www\./i.test(clean)) return null
  try {
    const audio = await synthesizeOpus(clean)
    if (audio.length > 500 * 1024) {
      console.warn(`[voz] áudio ${(audio.length / 1024).toFixed(0)}KB > 500KB — caindo pra texto`)
      return null
    }
    return audio.toString('base64')
  } catch (e) {
    console.error('[voz] falha ao sintetizar — caindo pra texto:', e)
    return null
  }
}
