import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '../../../../web/deepseek-harness/vendor/cordis/src/index.ts'
import ToolRuntime from '../../../../web/deepseek-harness/packages/core/tools/src/index.ts'
import SystemPrompt from '../../../../web/deepseek-harness/packages/core/system-prompt/src/index.ts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CliEnvelope } from '../../src/cli/protocol.ts'
import type { CliGateway, CliRunOptions } from '../../src/cli/gateway.ts'
import { createDoctorTool } from '../../src/tools/doctor.ts'
import { createImproveArticleTool } from '../../src/tools/improve-article.ts'
import { createPlanImagesTool } from '../../src/tools/plan-images.ts'
import { createStartArticleTool } from '../../src/tools/start-article.ts'
import { ArtifactStore } from '../../src/workspace/artifact-store.ts'

interface TestTarget {
  targetKey: string
  displayPath: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const signal = new AbortController().signal

function createTestFileSystem(cwd: string) {
  return {
    async resolve(path: string, options?: { cwd?: string }): Promise<TestTarget> {
      const displayPath = resolve(options?.cwd ?? cwd, path)
      let ancestor = displayPath
      const missing: string[] = []
      while (true) {
        try {
          return { displayPath, targetKey: join(await realpath(ancestor), ...missing) }
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
          missing.unshift(basename(ancestor))
          const parent = dirname(ancestor)
          if (parent === ancestor) return { displayPath, targetKey: displayPath }
          ancestor = parent
        }
      }
    },
    processPath(target: TestTarget): string { return target.targetKey },
    contains(parent: TestTarget, child: TestTarget): boolean {
      const candidate = relative(parent.targetKey, child.targetKey)
      return candidate === '' || (!candidate.startsWith('..') && !isAbsolute(candidate))
    },
    async stat(target: TestTarget) {
      try {
        const info = await stat(target.targetKey)
        return {
          version: `${info.mtimeMs}:${info.size}`,
          type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
          size: info.size,
        }
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
        throw error
      }
    },
    async readBytes(target: TestTarget, readSignal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
      readSignal?.throwIfAborted()
      try {
        const bytes = await readFile(target.targetKey)
        if (bytes.byteLength > maxBytes) {
          const tooLarge = new Error('file is too large') as Error & { code: string }
          tooLarge.code = 'FS_TOO_LARGE'
          throw tooLarge
        }
        return bytes
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          const missing = new Error('file not found') as Error & { code: string }
          missing.code = 'FS_NOT_FOUND'
          throw missing
        }
        if (error instanceof Error && 'code' in error && error.code === 'EISDIR') {
          const notFile = new Error('not a regular file') as Error & { code: string }
          notFile.code = 'FS_NOT_REGULAR_FILE'
          throw notFile
        }
        throw error
      }
    },
  }
}

function envelope(overrides: Partial<CliEnvelope> = {}): CliEnvelope {
  return {
    success: true,
    code: 'OK',
    message: 'Ready',
    schema_version: 'v1',
    status: 'completed',
    retryable: false,
    data: {},
    ...overrides,
  }
}

class FakeGateway implements CliGateway {
  readonly calls: Array<{ argv: readonly string[]; options: CliRunOptions | undefined }> = []
  constructor(private readonly respond: (argv: readonly string[]) => CliEnvelope = argv => envelope({
    code: 'REQUEST_READY',
    status: 'action_required',
    data: { command: argv[0], prompt: `Prepared ${argv[0]}` },
  })) {}
  resolve(): Promise<string> { return Promise.resolve('/fixture/md2wechat') }
  run(argv: readonly string[], options?: CliRunOptions): Promise<CliEnvelope> {
    this.calls.push({ argv: [...argv], options })
    return Promise.resolve(this.respond(argv))
  }
}

async function execute(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({ signal, callId: `call-${name}` as never, name, arguments: args })
}

async function setupToolContext(): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  const systemPrompt = await ctx.plugin(SystemPrompt)
  const tools = await ctx.plugin(ToolRuntime)
  return {
    ctx,
    async dispose() {
      await tools.dispose()
      await systemPrompt.dispose()
    },
  }
}

describe('article preparation tools', () => {
  let temporary: string
  let workspace: string
  let fs: ReturnType<typeof createTestFileSystem>
  let store: ArtifactStore
  let ctx: Context
  let disposeContext: () => Promise<void>

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'dsh-md2wechat-article-tools-'))
    workspace = join(temporary, 'workspace')
    await mkdir(workspace, { recursive: true })
    fs = createTestFileSystem(workspace)
    store = new ArtifactStore(fs as never, workspace, '.dsh/md2wechat')
    const setup = await setupToolContext()
    ctx = setup.ctx
    disposeContext = setup.dispose
  })

  afterEach(async () => {
    await disposeContext()
    await rm(temporary, { recursive: true, force: true })
  })

  it('registers exact strict schemas and replay-safe pure cards for all four tools', async () => {
    const gateway = new FakeGateway()
    const now = () => new Date('2026-08-25T01:02:03.000Z')
    const tools = [
      createDoctorTool({ gateway }),
      createStartArticleTool({ fs: fs as never, workspace, store, now }),
      createImproveArticleTool({ gateway, store, now }),
      createPlanImagesTool({ gateway, store, now }),
    ]
    for (const tool of tools) ctx.tools.register(tool)

    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual([
      'md2wechat_doctor',
      'md2wechat_start_article',
      'md2wechat_improve_article',
      'md2wechat_plan_images',
    ])
    await expect(execute(ctx, 'md2wechat_doctor', { unexpected: true })).resolves.toMatchObject({ isError: true })
    await expect(execute(ctx, 'md2wechat_start_article', {})).resolves.toMatchObject({ isError: true })
    await expect(execute(ctx, 'md2wechat_start_article', { sourcePath: 'x', unexpected: true }))
      .resolves.toMatchObject({ isError: true })
    await expect(execute(ctx, 'md2wechat_improve_article', {
      manifestPath: 'x', operation: 'unknown',
    })).resolves.toMatchObject({ isError: true })
    await expect(execute(ctx, 'md2wechat_improve_article', {
      manifestPath: 'x', operation: 'advise', unexpected: true,
    })).resolves.toMatchObject({ isError: true })
    await expect(execute(ctx, 'md2wechat_plan_images', { manifestPath: 'x', images: [], unexpected: true }))
      .resolves.toMatchObject({ isError: true })

    const start = tools[1]!
    expect(start.presentCall?.({ sourcePath: 'article.md', title: 'A' })).toEqual({
      card: 'generic', title: 'Start md2wechat article', kind: 'edit', rawInput: 'article.md',
      locations: [{ path: 'article.md' }],
    })
    const first = start.presentCall?.({ sourcePath: 'article.md' })
    expect(start.presentCall?.({ sourcePath: 'article.md' })).toEqual(first)
    expect(start.presentResult?.({ sourcePath: 'article.md' }, { content: [], isError: false })).toEqual({
      card: 'generic', title: 'Article workspace ready',
    })
    expect(tools[0]!.presentCall?.({})).toEqual({
      card: 'generic', title: 'Check md2wechat readiness', kind: 'read',
    })
    expect(tools[0]!.presentResult?.({}, { content: [], isError: false })).toEqual({
      card: 'generic', title: 'md2wechat diagnosis complete',
    })
    const revisionId = 'a'.repeat(64)
    const replayManifest = `revisions/${revisionId}/manifest.json`
    expect(tools[2]!.presentCall?.({ manifestPath: replayManifest, operation: 'advise' })).toEqual({
      card: 'generic', title: 'Prepare article improvement', kind: 'read', rawInput: 'advise',
      locations: [
        { path: replayManifest },
        { path: `revisions/${revisionId}/article.md` },
        { path: `revisions/${revisionId}/operations.jsonl` },
      ],
    })
    expect(tools[2]!.presentResult?.(
      { manifestPath: replayManifest, operation: 'advise' },
      { content: [], isError: false },
    )).toEqual({ card: 'generic', title: 'Article improvement prepared' })
    const imageArgs = {
      manifestPath: replayManifest,
      images: [{ id: 'hero', kind: 'image' as const, prompt: 'Hero', targetPath: 'images/hero.png' }],
    }
    expect(tools[3]!.presentCall?.(imageArgs)).toEqual({
      card: 'generic', title: 'Plan article images', kind: 'edit', rawInput: imageArgs.images,
      locations: [
        { path: replayManifest },
        { path: `revisions/${revisionId}/article.md` },
        { path: `revisions/${revisionId}/images/hero.png` },
      ],
    })
    expect(tools[3]!.presentResult?.(imageArgs, { content: [], isError: false })).toEqual({
      card: 'generic', title: 'Image plan ready',
    })
  })

  it('diagnoses ready and not-ready configuration without leaking references or secrets', async () => {
    const secret = 'super-secret-value'
    const reference = 'credential://wechat-production'
    const readyGateway = new FakeGateway(argv => {
      if (argv[0] === 'version') return envelope({ code: 'VERSION_SHOWN', data: { version: '3.3.0' } })
      if (argv[0] === 'capabilities') return envelope({ code: 'CAPABILITIES_SHOWN', data: { commands: ['advise'] } })
      if (argv[0] === 'config') return envelope({ code: 'CONFIG_VALID', data: { reference, api_key: secret } })
      return envelope({ code: 'PROVIDERS_LISTED', data: { providers: [{ name: 'openai', api_key: secret }] } })
    })
    ctx.tools.register(createDoctorTool({ gateway: readyGateway }))

    const ready = await execute(ctx, 'md2wechat_doctor', {})
    expect(ready.isError).toBe(false)
    expect(ready.value).toMatchObject({ ready: true, pluginVersion: '1.0.0', cliVersion: '3.3.0' })
    expect(JSON.stringify(ready)).not.toContain(secret)
    expect(JSON.stringify(ready)).not.toContain(reference)
    expect(ready.content[0]).toMatchObject({ type: 'text' })
    expect((ready.content[0] as { text: string }).text).toContain('ready')
    expect(readyGateway.calls.map(call => call.argv)).toEqual([
      ['version', '--json'], ['capabilities', '--json'], ['config', 'validate', '--json'], ['providers', 'list', '--json'],
    ])

    const notReadyGateway = new FakeGateway(argv => argv[0] === 'config'
      ? envelope({ success: false, code: 'CONFIG_INVALID', message: secret, status: 'failed', error: secret, data: { reference } })
      : envelope({ code: 'OK' }))
    const secondSetup = await setupToolContext()
    const second = secondSetup.ctx
    second.tools.register(createDoctorTool({ gateway: notReadyGateway }))
    const notReady = await execute(second, 'md2wechat_doctor', {})
    expect(notReady.isError).toBe(false)
    expect(notReady.value).toMatchObject({ ready: false, pluginVersion: '1.0.0', cliVersion: '3.3.0' })
    expect(JSON.stringify(notReady)).not.toContain(secret)
    expect(JSON.stringify(notReady)).not.toContain(reference)
    await secondSetup.dispose()
  })

  it('starts an immutable article revision with stable persisted article and manifest files', async () => {
    const source = join(workspace, 'article.md')
    const sourceBytes = encoder.encode('# Source\n\nBody.\n')
    await writeFile(source, sourceBytes)
    const sourceHash = createHash('sha256').update(sourceBytes).digest('hex')
    ctx.tools.register(createStartArticleTool({
      fs: fs as never, workspace, store, now: () => new Date('2026-08-25T01:02:03.000Z'),
    }))

    const result = await execute(ctx, 'md2wechat_start_article', { sourcePath: 'article.md', title: 'Source' })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      title: 'Source', pluginVersion: '1.0.0', cliVersion: '3.3.0', articleSha256: sourceHash,
    })
    const value = result.value as { revisionId: string; articlePath: string; manifestPath: string; locations: string[] }
    expect(value.revisionId).toMatch(/^[a-f0-9]{64}$/u)
    expect(value.articlePath).toBe(`revisions/${value.revisionId}/article.md`)
    expect(value.manifestPath).toBe(`revisions/${value.revisionId}/manifest.json`)
    expect(value.locations).toEqual([value.articlePath, value.manifestPath])
    expect(await readFile(source)).toEqual(Buffer.from(sourceBytes))
    expect(decoder.decode(await store.read(value.articlePath))).toBe('# Source\n\nBody.\n')
    expect(JSON.parse(decoder.decode(await store.read(value.manifestPath)))).toEqual({
      schemaVersion: 1,
      articlePath: 'article.md',
      manifestPath: 'manifest.json',
      createdAt: '2026-08-25T01:02:03.000Z',
      title: 'Source',
    })

    const repeated = await execute(ctx, 'md2wechat_start_article', { sourcePath: 'article.md', title: 'Source' })
    expect(repeated.value).toEqual(result.value)
  })

  it('rejects missing, non-regular, oversized, and escaping article sources', async () => {
    ctx.tools.register(createStartArticleTool({
      fs: fs as never, workspace, store, now: () => new Date('2026-08-25T01:02:03.000Z'),
    }))
    await mkdir(join(workspace, 'directory'))
    await writeFile(join(workspace, 'large.md'), Buffer.alloc(8 * 1024 * 1024 + 1, 65))
    const outside = join(temporary, 'outside.md')
    await writeFile(outside, 'outside')
    await symlink(outside, join(workspace, 'link.md'))

    for (const sourcePath of ['missing.md', 'directory', 'large.md', '../outside.md', 'link.md']) {
      const result = await execute(ctx, 'md2wechat_start_article', { sourcePath })
      expect(result.isError, sourcePath).toBe(true)
    }
  })

  it('prepares all four improvement operations with exact argv and records without changing article bytes', async () => {
    const manifestPath = await startFixtureArticle()
    const before = await store.read(manifestPath.replace('manifest.json', 'article.md'))
    const gateway = new FakeGateway(argv => envelope({
      code: 'REQUEST_READY', status: argv[0] === 'advise' ? 'completed' : 'action_required',
      data: { command: argv.slice(0, 2).join(' '), prompt: `Prepared ${argv[0]}` },
    }))
    ctx.tools.register(createImproveArticleTool({
      gateway, store, now: () => new Date('2026-08-25T02:00:00.000Z'),
    }))

    for (const operation of ['advise', 'title', 'humanize', 'writer_style'] as const) {
      const result = await execute(ctx, 'md2wechat_improve_article', { manifestPath, operation })
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({
        manifestPath, operation, cliCode: 'REQUEST_READY', pluginVersion: '1.0.0', cliVersion: '3.3.0',
        preparedRequest: { prompt: `Prepared ${operation === 'writer_style' ? 'write' : operation}` },
      })
      expect((result.content[0] as { text: string }).text).toContain('Prepared')
    }
    const articleProcessPath = await store.processPathForRead(manifestPath.replace('manifest.json', 'article.md'))
    expect(gateway.calls.map(call => call.argv)).toEqual([
      ['advise', articleProcessPath, '--json'],
      ['title', 'suggest', articleProcessPath, '--json'],
      ['humanize', articleProcessPath, '--json'],
      ['write', articleProcessPath, '--input-type', 'fragment', '--json'],
    ])
    expect(gateway.calls.every(call => call.options?.env === undefined && call.options?.secrets === undefined)).toBe(true)
    expect(await store.read(manifestPath.replace('manifest.json', 'article.md'))).toEqual(before)
    const operations = decoder.decode(await store.read(manifestPath.replace('manifest.json', 'operations.jsonl')))
    expect(operations.trim().split('\n')).toHaveLength(4)
  })

  it('rejects stale manifest and article revisions before invoking an improvement CLI command', async () => {
    const manifestPath = await startFixtureArticle()
    const gateway = new FakeGateway()
    ctx.tools.register(createImproveArticleTool({ gateway, store }))

    await store.writeAtomic(manifestPath.replace('manifest.json', 'article.md'), encoder.encode('# Changed\n'))
    const stale = await execute(ctx, 'md2wechat_improve_article', { manifestPath, operation: 'advise' })
    expect(stale.isError).toBe(true)
    expect(gateway.calls).toHaveLength(0)

    const unsafe = await execute(ctx, 'md2wechat_improve_article', {
      manifestPath: '../manifest.json', operation: 'advise',
    })
    expect(unsafe.isError).toBe(true)
    expect(gateway.calls).toHaveLength(0)
  })

  it('persists stable side-effect-free image plans with exact argv for every kind and preset mode', async () => {
    const manifestPath = await startFixtureArticle()
    const gateway = new FakeGateway(argv => envelope({
      code: 'IMAGE_PLAN_READY', status: 'action_required',
      data: { mode: 'plan', command: argv[0], side_effects: false, requires_provider: false, prompt: `Plan ${argv[0]}` },
    }))
    let planClock = 0
    ctx.tools.register(createPlanImagesTool({
      gateway,
      store,
      now: () => new Date(`2026-08-25T03:00:0${planClock++}.000Z`),
    }))
    const images = [
      { id: 'hero', kind: 'image', prompt: 'A mountain', targetPath: 'images/hero.png' },
      { id: 'diagram', kind: 'image', prompt: 'A diagram', targetPath: 'images/diagram.png', preset: 'diagram', aspect: '4:3' },
      { id: 'cover', kind: 'cover', prompt: 'Cover direction', targetPath: 'images/cover.png', aspect: '16:9' },
      { id: 'info', kind: 'infographic', prompt: 'Info direction', targetPath: 'images/info.png', preset: 'infographic-default' },
    ]

    const result = await execute(ctx, 'md2wechat_plan_images', { manifestPath, images })
    expect(result.isError).toBe(false)
    const value = result.value as { revisionId: string; planId: string; planPath: string; items: unknown[]; locations: string[] }
    expect(value.planId).toMatch(/^[a-f0-9]{64}$/u)
    expect(value.planPath).toBe(`revisions/${value.revisionId}/plans/${value.planId}.json`)
    expect(value.items).toHaveLength(4)
    expect(value.locations).toContain(value.planPath)
    const persisted = JSON.parse(decoder.decode(await store.read(value.planPath))) as { items: Array<Record<string, unknown>> }
    expect(persisted.items[0]).toMatchObject({ original: images[0], cliPlan: { mode: 'plan', side_effects: false } })
    const articleProcessPath = await store.processPathForRead(manifestPath.replace('manifest.json', 'article.md'))
    expect(gateway.calls.map(call => call.argv)).toEqual([
      ['generate_image', 'A mountain', '--plan', '--json'],
      ['generate_image', '--preset', 'diagram', '--article', articleProcessPath, '--aspect', '4:3', '--plan', '--json'],
      ['generate_cover', '--article', articleProcessPath, '--aspect', '16:9', '--plan', '--json'],
      ['generate_infographic', '--article', articleProcessPath, '--preset', 'infographic-default', '--plan', '--json'],
    ])
    expect(gateway.calls.every(call => call.options?.env === undefined && call.options?.secrets === undefined)).toBe(true)

    const repeated = await execute(ctx, 'md2wechat_plan_images', { manifestPath, images })
    expect(repeated.value).toEqual(result.value)
  })

  it('rejects duplicate IDs, unsafe targets, stale articles, and unsafe CLI plan responses', async () => {
    const manifestPath = await startFixtureArticle()
    const gateway = new FakeGateway(argv => envelope({
      code: 'IMAGE_PLAN_READY', status: 'action_required',
      data: { mode: 'execute', command: argv[0], side_effects: true, requires_provider: true },
    }))
    ctx.tools.register(createPlanImagesTool({ gateway, store }))
    const base = { id: 'hero', kind: 'image' as const, prompt: 'Hero', targetPath: 'images/hero.png' }

    for (const images of [
      [base, base],
      [{ ...base, targetPath: '../hero.png' }],
      [{ ...base, targetPath: '/tmp/hero.png' }],
      [{ ...base, id: 'bad/id' }],
    ]) {
      const result = await execute(ctx, 'md2wechat_plan_images', { manifestPath, images })
      expect(result.isError).toBe(true)
    }
    expect(gateway.calls).toHaveLength(0)

    const unsafePlan = await execute(ctx, 'md2wechat_plan_images', { manifestPath, images: [base] })
    expect(unsafePlan.isError).toBe(true)
    expect(gateway.calls).toHaveLength(1)

    const freshGateway = new FakeGateway()
    const staleSetup = await setupToolContext()
    const staleContext = staleSetup.ctx
    staleContext.tools.register(createPlanImagesTool({ gateway: freshGateway, store }))
    await store.writeAtomic(manifestPath.replace('manifest.json', 'article.md'), encoder.encode('# Stale\n'))
    const stale = await execute(staleContext, 'md2wechat_plan_images', { manifestPath, images: [base] })
    expect(stale.isError).toBe(true)
    expect(freshGateway.calls).toHaveLength(0)
    await staleSetup.dispose()
  })

  async function startFixtureArticle(): Promise<string> {
    const source = join(workspace, 'fixture.md')
    await writeFile(source, '# Fixture\n\nBody.\n')
    const tool = createStartArticleTool({
      fs: fs as never, workspace, store, now: () => new Date('2026-08-25T00:00:00.000Z'),
    })
    const startSetup = await setupToolContext()
    const startContext = startSetup.ctx
    startContext.tools.register(tool)
    const result = await execute(startContext, 'md2wechat_start_article', { sourcePath: source, title: 'Fixture' })
    await startSetup.dispose()
    if (result.isError) throw new Error('fixture article did not start')
    return (result.value as { manifestPath: string }).manifestPath
  }
})
