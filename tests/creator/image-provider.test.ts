import { expect, it } from 'vitest'
import { creatorImageProvider } from '../../src/creator/image-provider.ts'
it('pins actual CLI defaults and explicit trusted host configuration without workspace lookup', () => {
  expect(creatorImageProvider({}).env).toMatchObject({ IMAGE_PROVIDER: 'openai', IMAGE_API_BASE: 'https://api.openai.com/v1' })
  expect(creatorImageProvider({ IMAGE_PROVIDER: 'or', IMAGE_API_BASE: 'https://images.example/v1', IMAGE_MODEL: 'custom' })).toMatchObject({ origin: 'https://images.example', env: { IMAGE_PROVIDER: 'openrouter', IMAGE_MODEL: 'custom' } })
})
it('does not silently change unsupported provider or accept credential-bearing endpoints', () => {
  for (const env of [{ IMAGE_PROVIDER: 'gemini' }, { IMAGE_PROVIDER: 'tuzi' }, { IMAGE_API_BASE: 'http://bad.example' }, { IMAGE_API_BASE: 'https://user:secret@bad.example' }, { IMAGE_API_BASE: 'https://bad.example?token=secret' }]) expect(() => creatorImageProvider(env)).toThrow()
})
