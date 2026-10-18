import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import DeepSeekAISettings from '../../models/DeepSeekAISettings.mjs'

const SETTINGS_ID = 'global'
const ALLOWED_MODELS = new Set(['deepseek-flash', 'deepseek-v4-pro'])

function encryptionKey() {
  const secret = process.env.OVERLEAF_AI_SETTINGS_SECRET
  if (!secret || secret.length < 32) {
    throw new Error('OVERLEAF_AI_SETTINGS_SECRET is unavailable or too short')
  }
  return createHash('sha256')
    .update(`overleaf-deepseek-settings:${secret}`)
    .digest()
}

function encryptApiKey(apiKey) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const ciphertext = Buffer.concat([
    cipher.update(apiKey, 'utf8'),
    cipher.final(),
  ])
  return [iv, cipher.getAuthTag(), ciphertext]
    .map(part => part.toString('base64url'))
    .join('.')
}

function decryptApiKey(value) {
  const [iv, authTag, ciphertext] = value.split('.').map(part => Buffer.from(part, 'base64url'))
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

async function findSettings() {
  return await DeepSeekAISettings.findById(SETTINGS_ID).lean().exec()
}

async function getPublicSettings() {
  const settings = await findSettings()
  return {
    enabled: Boolean(settings?.enabled),
    model: ALLOWED_MODELS.has(settings?.model) ? settings.model : 'deepseek-flash',
    hasApiKey: Boolean(settings?.encryptedApiKey),
  }
}

async function getCredentials() {
  const settings = await findSettings()
  if (!settings?.enabled || !settings.encryptedApiKey) return null
  return {
    model: ALLOWED_MODELS.has(settings.model) ? settings.model : 'deepseek-flash',
    apiKey: decryptApiKey(settings.encryptedApiKey),
  }
}

async function saveSettings({ enabled, model, apiKey, clearApiKey }) {
  if (!ALLOWED_MODELS.has(model)) throw new Error('Unsupported DeepSeek model')
  const current = await findSettings()
  let encryptedApiKey = current?.encryptedApiKey || ''
  if (clearApiKey) encryptedApiKey = ''
  if (apiKey) encryptedApiKey = encryptApiKey(apiKey)

  await DeepSeekAISettings.findByIdAndUpdate(
    SETTINGS_ID,
    { $set: { enabled, model, encryptedApiKey } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).exec()
}

export default { getPublicSettings, getCredentials, saveSettings }
