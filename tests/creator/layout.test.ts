import { expect, it, vi } from 'vitest'
import { countLayoutModules, prepareLayoutRequest, assertLayoutLimit } from '../../src/creator/layout.ts'
import type { CliGateway } from '../../src/cli/gateway.ts'

it('counts modules outside backtick and tilde fences, including spaced openings', () => {
  expect(countLayoutModules('```md\n:::hero\n```\n~~~\n:::cards\n~~~\n::: hero\ntitle: X\n:::\n:::section-title variant=divider\n:::')).toBe(2)
  expect(() => assertLayoutLimit(':::hero\n:::\n'.repeat(8))).not.toThrow()
  expect(() => assertLayoutLimit(':::hero\n:::\n'.repeat(9))).toThrow('8 个')
})
it('discovers only available supported module definitions without preview or writes', async () => {
  const run = vi.fn<CliGateway['run']>(async argv => ({ success: true, code: 'LAYOUT_SHOWN', status: 'completed', schema_version: 'v1', retryable: false, message: 'catalog', data: argv[1] === 'list' ? { modules: [{ name: 'hero' }, { name: 'section-title' }, { name: 'unknown' }] } : { spec: { Name: argv[2], Example: 'provided by installed CLI' } } }))
  const result = await prepareLayoutRequest({ run } as unknown as CliGateway, ':::hero\n:::', new AbortController().signal)
  expect(result).toMatchObject({ existingModules: 1, maxModules: 8, definitions: [{ Name: 'hero' }, { Name: 'section-title' }] })
  expect(run.mock.calls.map(call => call[0])).toEqual([['layout', 'list', '--json'], ['layout', 'show', 'hero', '--json'], ['layout', 'show', 'section-title', '--json']])
})
it('does not invent layout support when discovery fails', async () => {
  const run = vi.fn<CliGateway['run']>(async () => ({ success: true, code: 'WRONG', status: 'completed', schema_version: 'v1', retryable: false, message: 'token=secret', data: {} }))
  await expect(prepareLayoutRequest({ run } as unknown as CliGateway, '', new AbortController().signal)).rejects.toThrow('[md2wechat:CLI_UNAVAILABLE]')
  expect(run).toHaveBeenCalledTimes(1)
})
