import { describe, expect, it } from 'vitest'
import { validateCliEnvelope } from '../../src/cli/protocol.ts'

const request = { argv: ['version', '--json'], requiredCommands: [] }

const envelope = {
  success: true,
  code: 'OK',
  schema_version: 'v1',
  status: 'completed',
  retryable: false,
  data: { version: '3.3.0' },
}

describe('validateCliEnvelope', () => {
  it.each([null, [], 'not JSON', 1])('rejects non-object JSON: %j', (value) => {
    expect(() => validateCliEnvelope(value, request)).toThrow('object')
  })

  it('rejects an unknown schema version', () => {
    expect(() => validateCliEnvelope({ ...envelope, schema_version: 'v2' }, request)).toThrow('schema_version')
  })

  it('rejects a data payload that is not an object', () => {
    expect(() => validateCliEnvelope({ ...envelope, data: [] }, {
      argv: ['convert', '--json'],
      requiredCommands: [],
    })).toThrow('data')
  })

  it('rejects an unsupported status', () => {
    expect(() => validateCliEnvelope({ ...envelope, status: 'pending' }, request)).toThrow('status')
  })

  it.each([
    { success: false, status: 'completed' },
    { success: true, status: 'failed' },
  ])('rejects conflicting success and status values', (conflict) => {
    expect(() => validateCliEnvelope({ ...envelope, ...conflict }, request)).toThrow('success')
  })

  it('rejects non-string capabilities', () => {
    expect(() => validateCliEnvelope({
      ...envelope,
      data: { version: '3.3.0', capabilities: ['convert', 1] },
    }, request)).toThrow('capabilities')
  })

  it('rejects an envelope missing a required command', () => {
    expect(() => validateCliEnvelope({
      ...envelope,
      data: { version: '3.3.0', capabilities: ['convert'] },
    }, { argv: ['capabilities', '--json'], requiredCommands: ['convert', 'publish'] })).toThrow('publish')
  })

  it('rejects a CLI version outside the supported version', () => {
    expect(() => validateCliEnvelope({
      ...envelope,
      data: { version: '3.2.9' },
    }, request)).toThrow('3.3.0')
  })

  it('accepts a supported completed version envelope', () => {
    expect(validateCliEnvelope(envelope, request)).toEqual(envelope)
  })
})
