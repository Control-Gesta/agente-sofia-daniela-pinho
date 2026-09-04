import { CONFIG } from './config'

/**
 * Ouvido do agente: transcreve áudio do paciente (OpenAI gpt-4o-mini-transcribe,
 * mesma chave usada pelo cérebro — decisão do cliente, ver lib/llm.ts). No
 * Kommo o link do anexo chega direto no webhook add_message
 * (message[add][0][attachment][link]) — transcrevemos ANTES de gravar no
 * histórico, então não precisa de cache separado (o dedup por msgId garante
 * que cada áudio é transcrito uma vez só).
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
const MAX_AUDIO_BYTES = 20 * 1024 * 1024

export function sttEnabled(): boolean {
  return !!CONFIG.openaiApiKey
}

export async function transcribeUrl(url: string): Promise<string | null> {
  if (!sttEnabled() || !url.startsWith('http')) return null
  try {
    const audioRes = await fetch(url, { headers: { 'User-Agent': UA } })
    if (!audioRes.ok) return null
    const audio = await audioRes.arrayBuffer()
    if (audio.byteLength === 0 || audio.byteLength > MAX_AUDIO_BYTES) return null

    // Extensão/mime pela URL: o Kommo manda ogg
    const ext = (url.match(/\.(mp3|m4a|ogg|oga|opus|wav|webm)(?:$|\?)/i)?.[1] || 'ogg').toLowerCase()
    const mime = { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', webm: 'audio/webm' }[ext] || 'audio/ogg'

    const form = new FormData()
    form.append('file', new Blob([audio], { type: mime }), `audio.${ext}`)
    form.append('model', 'gpt-4o-mini-transcribe')
    form.append('language', 'pt')
    form.append('response_format', 'json')

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${CONFIG.openaiApiKey}` },
      body: form,
    })
    if (!res.ok) {
      console.log(`[stt] transcrição falhou (${res.status}) — anexo provavelmente não é áudio`)
      return null
    }
    const d = (await res.json()) as { text?: string }
    return (d.text || '').trim() || null
  } catch (e) {
    console.error('[stt] erro (placeholder será usado):', e)
    return null
  }
}
