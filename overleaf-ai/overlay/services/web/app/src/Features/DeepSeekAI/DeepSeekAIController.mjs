import { expressify } from '@overleaf/promise-utils'
import DeepSeekAISettingsManager from './DeepSeekAISettingsManager.mjs'

const API_BASE = 'https://api.deepseek.com'
const REQUEST_TIMEOUT_MS = 12_000
const MAX_CONTEXT_CHARS = 3_000
const MAX_SELECTION_CHARS = 12_000

function jsonError(res, status, message) {
  res.status(status).json({ error: message })
}

function cleanModelText(value) {
  return value.replace(/^\s*```(?:latex|tex)?\s*\n?/i, '').replace(/\n?```\s*$/, '')
}

async function callDeepSeek(path, credentials, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credentials.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    const error = new Error(`DeepSeek returned HTTP ${response.status}`)
    error.status = response.status
    throw error
  }
  return await response.json()
}

const DeepSeekAIController = {
  getStatus: expressify(async (req, res) => {
    res.json(await DeepSeekAISettingsManager.getPublicSettings())
  }),

  saveSettings: expressify(async (req, res) => {
    const { enabled, model, apiKey, clearApiKey } = req.body || {}
    if (
      !['deepseek-flash', 'deepseek-v4-pro'].includes(model) ||
      typeof apiKey !== 'string' || apiKey.length > 500 ||
      (enabled !== undefined && enabled !== 'on') ||
      (clearApiKey !== undefined && clearApiKey !== 'on')
    ) {
      return jsonError(res, 400, 'Invalid AI settings')
    }
    await DeepSeekAISettingsManager.saveSettings({
      enabled: enabled === 'on',
      model,
      apiKey: apiKey.trim(),
      clearApiKey: clearApiKey === 'on',
    })
    res.redirect('/admin#ai-settings')
  }),

  complete: expressify(async (req, res) => {
    const { prefix, suffix } = req.body || {}
    if (
      typeof prefix !== 'string' || typeof suffix !== 'string' ||
      prefix.length > MAX_CONTEXT_CHARS || suffix.length > MAX_CONTEXT_CHARS
    ) {
      return jsonError(res, 400, 'Invalid completion context')
    }
    const credentials = await DeepSeekAISettingsManager.getCredentials()
    if (!credentials) return jsonError(res, 503, 'AI completion is not configured')

    try {
      const result = await callDeepSeek('/beta/completions', credentials, {
        model: credentials.model,
        prompt: prefix,
        suffix,
        max_tokens: 128,
        temperature: 0.15,
        stream: false,
      })
      res.json({ completion: result.choices?.[0]?.text || '' })
    } catch (error) {
      jsonError(res, error.status === 429 ? 429 : 502, 'DeepSeek completion request failed')
    }
  }),

  transform: expressify(async (req, res) => {
    const { instruction, selection, contextBefore, contextAfter } = req.body || {}
    if (
      typeof instruction !== 'string' || instruction.trim().length < 1 || instruction.length > 1_000 ||
      typeof selection !== 'string' || selection.length < 1 || selection.length > MAX_SELECTION_CHARS ||
      typeof contextBefore !== 'string' || contextBefore.length > MAX_CONTEXT_CHARS ||
      typeof contextAfter !== 'string' || contextAfter.length > MAX_CONTEXT_CHARS
    ) {
      return jsonError(res, 400, 'Invalid text transformation request')
    }
    const credentials = await DeepSeekAISettingsManager.getCredentials()
    if (!credentials) return jsonError(res, 503, 'AI assistant is not configured')

    try {
      const result = await callDeepSeek('/chat/completions', credentials, {
        model: credentials.model,
        messages: [
          {
            role: 'system',
            content: 'You edit LaTeX source. Return only the replacement for the selected text. Do not add Markdown fences or explanations. Preserve the original meaning and surrounding LaTeX structure unless the instruction asks to change them. Use valid LaTeX.',
          },
          {
            role: 'user',
            content: `Instruction: ${instruction.trim()}\n\nContext before selection:\n${contextBefore}\n\nSelected LaTeX to replace:\n${selection}\n\nContext after selection:\n${contextAfter}`,
          },
        ],
        max_tokens: 2_048,
        temperature: 0.2,
        stream: false,
      })
      const replacement = cleanModelText(result.choices?.[0]?.message?.content || '')
      if (!replacement.trim()) return jsonError(res, 502, 'DeepSeek returned an empty replacement')
      res.json({ replacement })
    } catch (error) {
      jsonError(res, error.status === 429 ? 429 : 502, 'DeepSeek transformation request failed')
    }
  }),
}

export default DeepSeekAIController
