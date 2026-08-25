import { describe, expect, it } from 'vitest'
import { Config as ConfigSchema, resolveConfig, type Config } from '../../src/config.ts'

const valid: Config = { binaryPath: '/opt/md2wechat' }

describe('resolveConfig', () => {
  it('rejects unknown fields through the exported configuration schema', () => {
    expect(() => ConfigSchema({ ...valid, unexpected: true } as unknown as Config)).toThrow('unknown configuration field')
  })

  it('rejects a relative binary path', () => {
    expect(() => resolveConfig({ ...valid, binaryPath: 'md2wechat' })).toThrow('absolute path')
  })

  it('rejects an artifacts directory outside the session workspace', () => {
    expect(() => resolveConfig({ ...valid, artifactsDir: '../outside' })).toThrow('session workspace')
  })

  it('rejects a non-positive foreground timeout', () => {
    expect(() => resolveConfig({ ...valid, foregroundTimeoutMs: 0 })).toThrow('positive integer')
  })

  it('rejects unsupported credential environment names', () => {
    expect(() => resolveConfig({
      ...valid,
      credentialRefs: { BAD_SECRET: 'env:BAD_SECRET' },
    } as unknown as Config)).toThrow('not supported')
  })

  it.each([
    ['previewFontSize', 'huge'],
    ['previewBackgroundType', 'paper'],
  ] as const)('rejects an unsupported %s', (field, value) => {
    expect(() => resolveConfig({ ...valid, [field]: value })).toThrow('supported')
  })

  it('rejects unknown runtime configuration fields', () => {
    expect(() => resolveConfig({ ...valid, unexpected: true } as unknown as Config)).toThrow('unknown configuration field')
  })

  it('returns the supplied absolute binary path and safe defaults', () => {
    expect(resolveConfig(valid)).toEqual({
      binaryPath: '/opt/md2wechat',
      artifactsDir: '.dsh/md2wechat',
      layoutBaseUrl: 'https://www.md2wechat.cn',
      previewTheme: 'default',
      previewFontSize: 'medium',
      previewBackgroundType: 'none',
      enableWechatWriteTools: true,
      enableFallbackImageTool: true,
      safeReadRetries: 1,
      safeReadRetryDelayMs: 500,
      foregroundTimeoutMs: 120000,
      imageJobTimeoutMs: 900000,
      credentialRefs: {},
    })
  })
})
