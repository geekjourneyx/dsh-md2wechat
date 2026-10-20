import { describe, expect, it } from 'vitest'
import { validateCliEnvelope } from '../../src/cli/protocol.ts'

const request = { argv: ['version', '--json'], requiredCommands: [] }

const envelope = {
  success: true,
  code: 'OK',
  message: 'completed',
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

  it('requires a string message and validates optional CLI error fields', () => {
    const { message: _message, ...missingMessage } = envelope
    expect(() => validateCliEnvelope(missingMessage, request)).toThrow('message')
    expect(() => validateCliEnvelope({ ...envelope, message: 1 }, request)).toThrow('message')
    expect(validateCliEnvelope({
      ...envelope,
      error: 'request failed',
      error_details: { field: 'title', problems: ['missing'] },
    }, request)).toMatchObject({
      error: 'request failed',
      error_details: { field: 'title', problems: ['missing'] },
    })
    expect(() => validateCliEnvelope({ ...envelope, error: 1 }, request)).toThrow('error')
    expect(() => validateCliEnvelope({ ...envelope, error_details: [] }, request)).toThrow('error_details')
  })

  it('keeps strict top-level field validation with the real CLI fields', () => {
    expect(() => validateCliEnvelope({ ...envelope, invented: true }, request)).toThrow('unsupported field')
    expect(() => validateCliEnvelope({ ...envelope, warnings: [] }, request)).toThrow('unsupported field')
  })

  it('rejects non-string commands', () => {
    expect(() => validateCliEnvelope({
      ...envelope,
      data: { version: '3.3.0', commands: ['convert', 1] },
    }, request)).toThrow('commands')
  })

  it('rejects an envelope missing a required command', () => {
    expect(() => validateCliEnvelope({
      ...envelope,
      data: { version: '3.3.0', commands: ['convert'] },
    }, { argv: ['capabilities', '--json'], requiredCommands: ['convert', 'publish'] })).toThrow('publish')
  })

  it('does not let an invented capabilities field mask missing real commands', () => {
    expect(() => validateCliEnvelope({
      ...envelope,
      data: { version: '3.3.0', commands: ['convert'], capabilities: ['convert', 'publish'] },
    }, { argv: ['capabilities', '--json'], requiredCommands: ['convert', 'publish'] })).toThrow('publish')
  })

  it.each(['3.3.0', '3.8.0', '99.0.0-compatible'])('accepts version %s without an exact release pin', (version) => {
    expect(validateCliEnvelope({ ...envelope, data: { version } }, request).data?.version).toBe(version)
  })

  it.each([undefined, null, 38, '', ' ', '3.8.0\nforged', 'x'.repeat(129)])('rejects malformed version identity %j', (version) => {
    expect(() => validateCliEnvelope({ ...envelope, data: version === undefined ? {} : { version } }, request)).toThrow('version')
  })

  it('accepts a supported completed version envelope', () => {
    expect(validateCliEnvelope(envelope, request)).toEqual(envelope)
  })
})
