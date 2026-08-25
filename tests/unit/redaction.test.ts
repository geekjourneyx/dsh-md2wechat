import { describe, expect, it } from 'vitest'
import { redactText, redactValue, sanitizeError } from '../../src/security/redaction.ts'

const secrets = ['plain-secret', 'a+plus&slash/?']

describe('redaction', () => {
  it('replaces raw and URI-encoded secret strings', () => {
    expect(redactText('raw=plain-secret encoded=a%2Bplus%26slash%2F%3F', secrets))
      .toBe('raw=[REDACTED] encoded=[REDACTED]')
  })

  it('redacts supplied secrets and sensitive fields recursively without mutating input', () => {
    const value = {
      apiKey: 'plain-secret',
      nested: [{ note: 'token=plain-secret', safe: 'kept' }],
      metadata: { ACCESS_TOKEN: 'a+plus&slash/?' },
    }

    expect(redactValue(value, secrets)).toEqual({
      apiKey: '[REDACTED]',
      nested: [{ note: 'token=[REDACTED]', safe: 'kept' }],
      metadata: { ACCESS_TOKEN: '[REDACTED]' },
    })
    expect(value).toEqual({
      apiKey: 'plain-secret',
      nested: [{ note: 'token=plain-secret', safe: 'kept' }],
      metadata: { ACCESS_TOKEN: 'a+plus&slash/?' },
    })
  })

  it('rejects cyclic values instead of returning unsafe output', () => {
    const value: { self?: unknown } = {}
    value.self = value
    expect(() => redactValue(value, secrets)).toThrow('cyclic')
  })

  it('never retains a secret in a sanitized error message', () => {
    const error = sanitizeError(new Error('request failed for plain-secret and a%2Bplus%26slash%2F%3F'), secrets)
    expect(error.message).toBe('request failed for [REDACTED] and [REDACTED]')
    expect(error.message).not.toContain('plain-secret')
    expect(error.message).not.toContain('a%2Bplus%26slash%2F%3F')
  })
})
