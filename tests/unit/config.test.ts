import { describe, expect, it } from 'vitest'
import { resolveConfig, type Config } from '../../src/config.ts'

const valid: Config = { binaryPath: '/opt/md2wechat' }

describe('resolveConfig', () => {
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

  it('rejects unknown runtime configuration fields', () => {
    expect(() => resolveConfig({ ...valid, unexpected: true } as unknown as Config)).toThrow('unknown configuration field')
  })

  it('returns the supplied absolute binary path and safe defaults', () => {
    expect(resolveConfig(valid)).toEqual({
      binaryPath: '/opt/md2wechat',
      artifactsDir: '.dsh/md2wechat',
      layoutBaseUrl: 'https://www.md2wechat.cn',
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
