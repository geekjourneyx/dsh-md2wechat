import { describe, expect, it, vi } from 'vitest'
import type { CredentialEnvironmentName } from '../../src/config.ts'
import { resolveOperationEnv } from '../../src/security/credentials.ts'

describe('resolveOperationEnv', () => {
  it('resolves only requested configured names and returns their values for redaction', async () => {
    const resolve = vi.fn(async (reference: string) => ({ value: `resolved:${reference}`, source: 'memory' }))

    const result = await resolveOperationEnv(['WECHAT_APPID'], {
      credentialRefs: {
        WECHAT_APPID: 'ACCOUNT_APP_ID',
        WECHAT_SECRET: 'ACCOUNT_SECRET',
      },
      credentials: { resolve },
    })

    expect(result).toEqual({
      env: { WECHAT_APPID: 'resolved:ACCOUNT_APP_ID' },
      secrets: ['resolved:ACCOUNT_APP_ID'],
    })
    expect(resolve).toHaveBeenCalledOnce()
    expect(resolve).toHaveBeenCalledWith('ACCOUNT_APP_ID')
  })

  it('never treats a credential reference as the CLI secret value', async () => {
    const result = await resolveOperationEnv(['IMAGE_API_KEY'], {
      credentialRefs: { IMAGE_API_KEY: 'IMAGE_PROVIDER_REFERENCE' },
      credentials: {
        resolve: async () => ({ value: 'provider-secret', source: 'memory' }),
      },
    })

    expect(result.env).toEqual({ IMAGE_API_KEY: 'provider-secret' })
    expect(Object.values(result.env)).not.toContain('IMAGE_PROVIDER_REFERENCE')
    expect(result.secrets).toEqual(['provider-secret'])
  })

  it('omits an unconfigured optional name without consulting the provider', async () => {
    const resolve = vi.fn()
    await expect(resolveOperationEnv(['MD2WECHAT_API_KEY'], {
      credentialRefs: {},
      credentials: { resolve },
    })).resolves.toEqual({ env: {}, secrets: [] })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('rejects a configured reference that cannot be resolved', async () => {
    await expect(resolveOperationEnv(['WECHAT_SECRET'], {
      credentialRefs: { WECHAT_SECRET: 'MISSING_SECRET' },
      credentials: { resolve: async () => undefined },
    })).rejects.toThrow('WECHAT_SECRET')
  })

  it('rejects an invalid credential reference before resolution', async () => {
    const resolve = vi.fn()
    await expect(resolveOperationEnv(['WECHAT_SECRET'], {
      credentialRefs: { WECHAT_SECRET: 'plaintext secret value' },
      credentials: { resolve },
    })).rejects.toThrow('reference')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('rejects names outside the configuration allowlist before credential resolution', async () => {
    const resolve = vi.fn()
    await expect(resolveOperationEnv(['PATH' as CredentialEnvironmentName], {
      credentialRefs: { PATH: 'UNSAFE_REFERENCE' },
      credentials: { resolve },
    })).rejects.toThrow('not supported')
    expect(resolve).not.toHaveBeenCalled()
  })
})
