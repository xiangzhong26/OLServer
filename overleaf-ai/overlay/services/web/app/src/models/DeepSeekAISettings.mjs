import mongoose from '../infrastructure/Mongoose.mjs'

const { Schema } = mongoose

const DeepSeekAISettingsSchema = new Schema(
  {
    _id: { type: String, required: true },
    enabled: { type: Boolean, default: false },
    model: {
      type: String,
      enum: ['deepseek-flash', 'deepseek-v4-pro'],
      default: 'deepseek-flash',
    },
    encryptedApiKey: { type: String, default: '' },
  },
  { minimize: false, versionKey: false }
)

export default mongoose.model('DeepSeekAISettings', DeepSeekAISettingsSchema)
