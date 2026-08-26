import { resolve } from 'node:path'
import { Context } from '../../../../web/deepseek-harness/vendor/cordis/src/index.ts'
import ToolRuntime, { defineTool } from '../../../../web/deepseek-harness/packages/core/tools/src/index.ts'
import SystemPrompt from '../../../../web/deepseek-harness/packages/core/system-prompt/src/index.ts'
import { afterEach, describe, expect, it } from 'vitest'
import * as plugin from '../../src/index.ts'
import type { Config } from '../../src/config.ts'

const BASE_TOOLS = [
  'md2wechat_doctor',
  'md2wechat_start_article',
  'md2wechat_improve_article',
  'md2wechat_plan_images',
  'md2wechat_preview',
  'md2wechat_export',
] as const

const ALL_TOOLS = [...BASE_TOOLS, 'md2wechat_create_draft', 'md2wechat_generate_images'] as const

interface FakeSubprocessOptions {
  malformed?: boolean
  missingCapability?: boolean
  probeFailure?: boolean
  resolveFailure?: boolean
  version?: string
  waitForAbort?: boolean
}

interface SpawnSpec {
  argv: readonly string[]
  signal?: AbortSignal
}

class FakeSubprocess {
  readonly calls: string[][] = []
  readonly resolveStarted = Promise.withResolvers<void>()

  constructor(private readonly options: FakeSubprocessOptions = {}) {}

  async resolveExecutable(path: string, _env: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    this.resolveStarted.resolve()
    if (this.options.resolveFailure) throw new Error('missing executable')
    if (!this.options.waitForAbort) return path
    return await new Promise<string>((_resolve, reject) => {
      const onAbort = (): void => reject(signal?.reason ?? new Error('cancelled'))
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
  }

  spawn(spec: SpawnSpec) {
    const argv = spec.argv.slice(1)
    this.calls.push(argv)
    const commands = [
      'inspect', 'advise', 'preview', 'config', 'write', 'humanize', 'title',
      'upload_image', 'download_and_upload', 'generate_image', 'generate_cover',
      'generate_infographic', 'create_draft', 'providers', 'capabilities', 'version',
    ]
    if (this.options.missingCapability) commands.pop()
    const data = argv[0] === 'version'
      ? { version: this.options.version ?? '3.3.0' }
      : { commands }
    const envelope = this.options.probeFailure
      ? { success: false, code: 'NOT_READY', message: 'not ready', schema_version: 'v1', status: 'failed', retryable: false }
      : { success: true, code: 'OK', message: 'completed', schema_version: 'v1', status: 'completed', retryable: false, data }
    const text = this.options.malformed
      ? '{broken'
      : JSON.stringify(envelope)
    const read = (value: string) => ({ readFrom: () => ({ text: value, nextOffset: value.length, lossy: false }) })
    return {
      done: Promise.resolve({ exitCode: this.options.probeFailure ? 1 : 0, signal: null }),
      waitForExit: () => Promise.resolve(),
      collected: { stdout: read(text), stderr: read('') },
    }
  }
}

interface HarnessFixture {
  ctx: Context
  subprocess: FakeSubprocess
  registrations: string[]
  firstRegistrationCalls: string[][]
  runningJobs: Set<string>
}

const mounted: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(mounted.splice(0).reverse().map(dispose => dispose()))
})

async function harness(options: FakeSubprocessOptions = {}): Promise<HarnessFixture> {
  const ctx = new Context()
  const prompt = await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  const tools = await ctx.plugin(ToolRuntime, { mode: 'native' })
  mounted.push(() => tools.dispose(), () => prompt.dispose())

  const subprocess = new FakeSubprocess(options)
  const runningJobs = new Set<string>()
  ctx.provide('subprocess', subprocess as never)
  ctx.provide('fs', {} as never)
  ctx.provide('approval', { request: () => Promise.resolve('rejected') } as never)
  ctx.provide('credentials', { resolve: () => Promise.resolve(undefined) } as never)
  ctx.provide('jobs', {
    start: () => { throw new Error('jobs are not executed in plugin composition tests') },
    get: (_owner: unknown, id: string) => runningJobs.has(id) ? { id } : undefined,
  } as never)

  const registrations: string[] = []
  const firstRegistrationCalls: string[][] = []
  let visible = new Set(ALL_TOOLS.filter(name => ctx.tools.get(name) !== undefined))
  ctx.on('tools/change', () => {
    const current = new Set(ALL_TOOLS.filter(name => ctx.tools.get(name) !== undefined))
    const additions = ALL_TOOLS.filter(name => current.has(name) && !visible.has(name))
    if (additions.length > 0 && registrations.length === 0) {
      firstRegistrationCalls.push(...subprocess.calls.map(call => [...call]))
    }
    registrations.push(...additions)
    visible = current
  })
  return { ctx, subprocess, registrations, firstRegistrationCalls, runningJobs }
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    binaryPath: resolve('/opt/md2wechat'),
    stateDir: resolve('/var/lib/dsh-md2wechat-plugin-test'),
    safeReadRetries: 0,
    ...overrides,
  }
}

function visibleTools(ctx: Context): string[] {
  return ALL_TOOLS.filter(name => ctx.tools.get(name) !== undefined)
}

async function promptText(ctx: Context): Promise<string> {
  return (await ctx.systemPrompt.assemble()).sections
    .filter(section => section.name === 'tool:md2wechat')
    .map(section => section.text)
    .join('\n')
}

describe('DSH plugin entry and activation', () => {
  it('exports the exact public plugin identity, schema, injection list, and async entry', () => {
    expect(plugin.name).toBe('dsh-md2wechat')
    expect(plugin.Config).toBeTypeOf('function')
    expect(plugin.apply).toBeTypeOf('function')
    expect(plugin.inject).toEqual(['tools', 'subprocess', 'fs', 'approval', 'credentials', 'jobs', 'systemPrompt'])
  })

  it('probes version then capabilities before registering anything', async () => {
    const fixture = await harness()
    const fiber = await fixture.ctx.plugin(plugin, config({ enableWechatWriteTools: false, enableFallbackImageTool: false }))
    mounted.push(() => fiber.dispose())

    expect(fixture.firstRegistrationCalls).toEqual([['version', '--json'], ['capabilities', '--json']])
    expect(fixture.subprocess.calls).toEqual([['version', '--json'], ['capabilities', '--json']])
  })

  it.each([
    ['missing executable', { resolveFailure: true }],
    ['wrong version', { version: '3.2.9' }],
    ['missing capability', { missingCapability: true }],
    ['malformed probe', { malformed: true }],
    ['valid failed probe', { probeFailure: true }],
  ] as const)('fails loud for %s without tools or prompt guidance', async (_label, options) => {
    const fixture = await harness(options)
    const fiber = fixture.ctx.plugin(plugin, config())
    await expect(Promise.resolve(fiber)).rejects.toBeInstanceOf(Error)
    expect(visibleTools(fixture.ctx)).toEqual([])
    expect(await promptText(fixture.ctx)).toBe('')
    await fiber.dispose()
  })

  it('cancels an in-flight activation without registering tools or prompt guidance', async () => {
    const fixture = await harness({ waitForAbort: true })
    const fiber = fixture.ctx.plugin(plugin, config())
    const activation = Promise.resolve(fiber).then(() => undefined, () => undefined)
    await fixture.subprocess.resolveStarted.promise
    await fiber.dispose()
    await activation
    expect(visibleTools(fixture.ctx)).toEqual([])
    expect(await promptText(fixture.ctx)).toBe('')
  })

  it('rolls back earlier registrations when a later registration collides', async () => {
    const fixture = await harness()
    fixture.ctx.tools.register(defineTool({
      name: 'md2wechat_preview',
      description: 'collision sentinel',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
      async execute() { return {} },
    }))

    const fiber = fixture.ctx.plugin(plugin, config({ enableWechatWriteTools: false, enableFallbackImageTool: false }))
    await expect(Promise.resolve(fiber)).rejects.toThrow('already registered')
    expect(visibleTools(fixture.ctx)).toEqual(['md2wechat_preview'])
    expect(await promptText(fixture.ctx)).toBe('')
    await fiber.dispose()
  })
})

describe('feature gates and lifecycle ownership', () => {
  it.each([
    ['base only', false, false, [...BASE_TOOLS]],
    ['write without fallback', true, false, [...BASE_TOOLS, 'md2wechat_create_draft']],
    ['fallback switch without write', false, true, [...BASE_TOOLS]],
    ['write with fallback', true, true, [...BASE_TOOLS, 'md2wechat_create_draft', 'md2wechat_generate_images']],
  ] as const)('registers %s in exact order with matching prompt text', async (_label, write, fallback, expected) => {
    const fixture = await harness()
    const fiber = await fixture.ctx.plugin(plugin, config({
      enableWechatWriteTools: write,
      enableFallbackImageTool: fallback,
    }))
    mounted.push(() => fiber.dispose())

    expect(fixture.registrations).toEqual(expected)
    expect(visibleTools(fixture.ctx)).toEqual(expected)
    expect(new Set(fixture.registrations).size).toBe(fixture.registrations.length)
    const text = await promptText(fixture.ctx)
    expect(text).toContain('md2wechat_start_article')
    expect(text).toContain('md2wechat_improve_article')
    expect(text).toContain('md2wechat_plan_images')
    expect(text).toContain('md2wechat_preview')
    expect(text).toContain('md2wechat_export')
    expect(text).toContain('signed preview')
    expect(text.includes('md2wechat_create_draft')).toBe(write)
    expect(text.includes('unpublished WeChat draft')).toBe(write)
    expect(text.includes('md2wechat_generate_images')).toBe(write && fallback)
    expect(text.includes('no other image-generation capability')).toBe(write && fallback)
    if (write) {
      expect(text).toContain('never publishes or mass-sends')
    }
  })

  it('disposes and reloads every contribution exactly once without detaching registered jobs', async () => {
    const fixture = await harness()
    fixture.runningJobs.add('md2wechat-image-1')
    const first = await fixture.ctx.plugin(plugin, config())
    expect(visibleTools(fixture.ctx)).toEqual([...ALL_TOOLS])
    expect(await promptText(fixture.ctx)).not.toBe('')

    await first.dispose()
    expect(visibleTools(fixture.ctx)).toEqual([])
    expect(await promptText(fixture.ctx)).toBe('')
    expect(fixture.runningJobs).toEqual(new Set(['md2wechat-image-1']))

    const second = await fixture.ctx.plugin(plugin, config())
    mounted.push(() => second.dispose())
    expect(visibleTools(fixture.ctx)).toEqual([...ALL_TOOLS])
    expect(fixture.registrations).toEqual([...ALL_TOOLS, ...ALL_TOOLS])
    expect(fixture.subprocess.calls).toEqual([
      ['version', '--json'], ['capabilities', '--json'],
      ['version', '--json'], ['capabilities', '--json'],
    ])
  })
})
