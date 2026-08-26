import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
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
  beforeAuthorization?: (argv: readonly string[], options: CliRunOptions | undefined) => void | Promise<void>
  constructor(private readonly respond: (argv: readonly string[], options?: CliRunOptions) => CliEnvelope | Promise<CliEnvelope> = validCliResponse) {}
  resolve(): Promise<string> { return Promise.resolve('/fixture/md2wechat') }
  async run(argv: readonly string[], options?: CliRunOptions): Promise<CliEnvelope> {
    await this.beforeAuthorization?.(argv, options)
    if (options?.beforeSpawn !== undefined) await options.beforeSpawn(options.signal ?? signal)
    this.calls.push({ argv: [...argv], options })
    return this.respond(argv, options)
  }
}

function validCliResponse(argv: readonly string[]): CliEnvelope {
  const article = operationArticle(argv)
  switch (argv[0]) {
    case 'advise':
      return envelope({ code: 'ADVISE_COMPLETED', data: {
        schema_version: 'v1', command: 'advise', source: article, decision: 'enhance_minimally',
        article: {
          type: 'essay', confidence: 'high',
          stats: {
            word_count: 3, h1_count: 1, h2_count: 0, paragraph_count: 1,
            image_count: 0, blockquote_count: 0, ordered_list_count: 0,
          },
          signals: ['clear structure'], uncertainties: [],
        },
        actions: [{
          tool: 'title', state: 'recommended', reason: 'Strengthen the title',
          evidence: [{ code: 'TITLE_GENERIC', message: 'The title can be more specific', location: { line: 1, section: 'title' } }],
          command_hint: `md2wechat title suggest ${article} --json`,
          command_args: ['md2wechat', 'title', 'suggest', article, '--json'], requires_confirmation: false,
        }],
        layout: {
          max_modules: 3,
          recommended: [{
            name: 'summary', state: 'recommended', reason: 'Clarifies the takeaway',
            evidence: [{ code: 'SUMMARY_HELPFUL', message: 'The article has one core point' }],
          }],
          rejected: [],
        },
        micro_edits: [{
          kind: 'tighten', reason: 'Remove filler',
          evidence: [{ code: 'FILLER', message: 'One sentence is verbose' }], requires_confirmation: false,
        }],
        do_not_do: ['Do not change the argument'],
      } })
    case 'title':
      return envelope({ code: 'TITLE_SUGGEST_REQUEST_READY', status: 'action_required', data: {
        action: 'ai_title_suggestion_request', execution_owner: 'host_agent', prompt_kind: 'title',
        prompt_name: 'wechat-title-expert', prompt: 'Prepared title prompt', article_title: 'Fixture',
        article_chars: 13, target_reader: 'Readers', title_count: 10, max_title_chars: 25,
        hook_level: 1, hook_level_label: 'restrained', side_effects: false,
        requires_external_model: true, recommendation_only: true, article_path: article,
      } })
    case 'humanize':
      return envelope({ code: 'HUMANIZE_REQUEST_READY', status: 'action_required', data: {
        action: 'humanize_request', request: { content: '# Fixture\n\nBody.\n', intensity: 'medium', prompt: 'Prepared humanize prompt' },
      } })
    case 'write':
      return envelope({ code: 'WRITE_AI_REQUEST_READY', status: 'action_required', data: {
        mode: 'ai', action: 'ai_write_request', style: 'Dan Koe', prompt: 'Prepared writer prompt',
      } })
    case 'generate_image':
    case 'generate_cover':
    case 'generate_infographic':
      return validImageEnvelope(argv[0], argv.includes('--article') ? article : '')
    default:
      return envelope()
  }
}

function validImageEnvelope(command: string, article: string): CliEnvelope {
  return envelope({ code: 'IMAGE_PLAN_READY', status: 'action_required', data: {
    mode: 'plan', command, execution_owner: 'host_agent', side_effects: false,
    requires_provider: false, requires_image_api_key: false, prompt: `Prepared ${command} prompt`,
    raw_prompt: '', preset: '', archetype: '', primary_use_case: '', compatible_use_cases: [],
    recommended_aspect_ratios: [], default_aspect_ratio: '', article, title: '', summary: '', keywords: '',
    style: '', aspect: '', size: '', model_hint: '', suggested_filename: `${command}.png`, alt_text: command,
  } })
}

function operationArticle(argv: readonly string[]): string {
  const articleFlag = argv.indexOf('--article')
  if (articleFlag >= 0) return argv[articleFlag + 1] ?? ''
  return argv[0] === 'title' ? argv[2] ?? '' : argv[1] ?? ''
}

async function execute(ctx: Context, name: string, args: unknown) {
  return executeWithSignal(ctx, signal, name, args)
}

async function executeWithSignal(ctx: Context, executionSignal: AbortSignal, name: string, args: unknown) {
  return ctx.tools.execute({ signal: executionSignal, callId: `call-${name}` as never, name, arguments: args })
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
      if (argv[0] === 'config') return envelope({ code: 'CONFIG_VALIDATED', data: { reference, api_key: secret } })
      return envelope({ code: 'PROVIDERS_SHOWN', data: { providers: [{ name: 'openai', api_key: secret }] } })
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

    const notReadyGateway = new FakeGateway(argv => {
      if (argv[0] === 'version') return envelope({ code: 'VERSION_SHOWN', data: { version: '3.3.0' } })
      if (argv[0] === 'capabilities') return envelope({ code: 'CAPABILITIES_SHOWN', data: { commands: [] } })
      if (argv[0] === 'config') {
        return envelope({ success: false, code: `CONFIG_${secret}`, message: secret, status: 'failed', error: secret, data: { reference } })
      }
      return envelope({ code: 'PROVIDERS_SHOWN', data: { providers: [] } })
    })
    const secondSetup = await setupToolContext()
    const second = secondSetup.ctx
    second.tools.register(createDoctorTool({ gateway: notReadyGateway }))
    const notReady = await execute(second, 'md2wechat_doctor', {})
    expect(notReady.isError).toBe(false)
    expect(notReady.value).toMatchObject({ ready: false, pluginVersion: '1.0.0', cliVersion: '3.3.0' })
    expect(notReady.value).toMatchObject({ probes: expect.arrayContaining([{ name: 'config', ready: false, code: 'CONFIG_NOT_READY', status: 'failed' }]) })
    expect(JSON.stringify(notReady)).not.toContain(secret)
    expect(JSON.stringify(notReady)).not.toContain(reference)
    await secondSetup.dispose()
  })

  it('propagates doctor cancellation and does not run later probes', async () => {
    const controller = new AbortController()
    const gateway = new FakeGateway((_argv, options) => {
      controller.abort(new Error('cancel doctor'))
      return Promise.reject(options?.signal?.reason ?? new Error('cancel doctor'))
    })
    ctx.tools.register(createDoctorTool({ gateway }))

    const result = await executeWithSignal(ctx, controller.signal, 'md2wechat_doctor', {})
    expect(result.isError).toBe(true)
    expect(gateway.calls.map(call => call.argv)).toEqual([['version', '--json']])
    expect(gateway.calls[0]?.options?.signal).toBe(controller.signal)
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
    const gateway = new FakeGateway()
    ctx.tools.register(createImproveArticleTool({
      gateway, store, now: () => new Date('2026-08-25T02:00:00.000Z'),
    }))

    for (const operation of ['advise', 'title', 'humanize', 'writer_style'] as const) {
      const result = await execute(ctx, 'md2wechat_improve_article', { manifestPath, operation })
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({
        manifestPath, operation, pluginVersion: '1.0.0', cliVersion: '3.3.0',
      })
      expect((result.content[0] as { text: string }).text).toContain('Prepared')
    }
    const articleProcessPath = await realpath(store.resolve(manifestPath.replace('manifest.json', 'article.md')))
    expect(gateway.calls.map(call => call.argv)).toEqual([
      ['advise', articleProcessPath, '--json'],
      ['title', 'suggest', articleProcessPath, '--json'],
      ['humanize', articleProcessPath, '--json'],
      ['write', articleProcessPath, '--input-type', 'fragment', '--json'],
    ])
    expect(gateway.calls.every(call => call.options?.env === undefined && call.options?.secrets === undefined)).toBe(true)
    expect(gateway.calls.every(call => call.options?.signal === signal && call.options.beforeSpawn !== undefined)).toBe(true)
    expect(await store.read(manifestPath.replace('manifest.json', 'article.md'))).toEqual(before)
    const operations = decoder.decode(await store.read(manifestPath.replace('manifest.json', 'operations.jsonl')))
    expect(operations.trim().split('\n')).toHaveLength(4)
    expect(operations).not.toContain(workspace)
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

  it('rejects an article rewritten at the same path immediately before an improvement spawn', async () => {
    const manifestPath = await startFixtureArticle()
    const articlePath = store.resolve(manifestPath.replace('manifest.json', 'article.md'))
    const gateway = new FakeGateway()
    gateway.beforeAuthorization = () => writeFile(articlePath, '# Rewritten before spawn\n')
    ctx.tools.register(createImproveArticleTool({ gateway, store }))

    const result = await execute(ctx, 'md2wechat_improve_article', { manifestPath, operation: 'advise' })
    expect(result.isError).toBe(true)
    expect(gateway.calls).toHaveLength(0)
    await expect(store.read(manifestPath.replace('manifest.json', 'operations.jsonl')))
      .rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it.each([
    ['advise', (response: CliEnvelope) => ({ ...response, code: 'ADVISE_WRONG' })],
    ['title', (response: CliEnvelope) => ({ ...response, data: { ...response.data, action: 'wrong_title_action' } })],
    ['humanize', (response: CliEnvelope) => ({ ...response, data: { ...response.data, request: { content: 'Body', intensity: 'medium', prompt: '' } } })],
    ['writer_style', (response: CliEnvelope) => ({ ...response, data: { ...response.data, mode: 'completed' } })],
  ] as const)('rejects malformed %s CLI projections before recording them', async (operation, mutate) => {
    const manifestPath = await startFixtureArticle()
    const gateway = new FakeGateway(argv => mutate(validCliResponse(argv)))
    const isolated = await setupToolContext()
    isolated.ctx.tools.register(createImproveArticleTool({ gateway, store }))

    const result = await execute(isolated.ctx, 'md2wechat_improve_article', { manifestPath, operation })
    expect(result.isError).toBe(true)
    await expect(store.read(manifestPath.replace('manifest.json', 'operations.jsonl')))
      .rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    await isolated.dispose()
  })

  it.each([
    ['advise top-level secret', 'advise', (response: CliEnvelope) => ({
      ...response, data: { ...response.data, api_key: 'sk-secret-advice' },
    })],
    ['advise nested absolute path', 'advise', (response: CliEnvelope) => ({
      ...response,
      data: {
        ...response.data,
        article: {
          ...((response.data?.article ?? {}) as Record<string, unknown>),
          stats: {
            ...(((response.data?.article as Record<string, unknown> | undefined)?.stats ?? {}) as Record<string, unknown>),
            workspace_path: '/private/secret/article.md',
          },
        },
      },
    })],
    ['advise malformed nested location', 'advise', (response: CliEnvelope) => ({
      ...response,
      data: {
        ...response.data,
        actions: [{
          tool: 'title', state: 'recommended', reason: 'Strengthen the title',
          evidence: [{ code: 'TITLE_GENERIC', message: 'Specificity needed', location: { line: 'first' } }],
          requires_confirmation: false,
        }],
      },
    })],
    ['title arbitrary path', 'title', (response: CliEnvelope) => ({
      ...response, data: { ...response.data, debug_path: '/private/secret/title.md' },
    })],
    ['humanize nested secret', 'humanize', (response: CliEnvelope) => ({
      ...response,
      data: {
        ...response.data,
        request: { ...((response.data?.request ?? {}) as Record<string, unknown>), api_key: 'sk-secret-humanize' },
      },
    })],
    ['writer unsupported cover field', 'writer_style', (response: CliEnvelope) => ({
      ...response, data: { ...response.data, cover_prompt: '/private/secret/cover.png' },
    })],
  ] as const)('rejects unknown or malformed canonical projection fields: %s', async (_case, operation, mutate) => {
    const manifestPath = await startFixtureArticle()
    const gateway = new FakeGateway(argv => mutate(validCliResponse(argv)))
    const isolated = await setupToolContext()
    isolated.ctx.tools.register(createImproveArticleTool({ gateway, store }))

    const result = await execute(isolated.ctx, 'md2wechat_improve_article', { manifestPath, operation })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain('sk-secret')
    expect(JSON.stringify(result)).not.toContain('/private/secret')
    await expect(store.read(manifestPath.replace('manifest.json', 'operations.jsonl')))
      .rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    await isolated.dispose()
  })

  it('persists stable side-effect-free image plans with exact argv for every kind and preset mode', async () => {
    const manifestPath = await startFixtureArticle()
    const gateway = new FakeGateway()
    let planClock = 0
    ctx.tools.register(createPlanImagesTool({
      gateway,
      store,
      now: () => new Date(`2026-08-25T03:00:0${planClock++}.000Z`),
    }))
    const images = [
      { id: 'hero', kind: 'image', prompt: 'A mountain', targetPath: 'images/hero.png', aspect: '1:1' },
      { id: 'diagram', kind: 'image', prompt: 'A diagram', targetPath: 'images/diagram.png', preset: 'diagram', aspect: '4:3' },
      { id: 'cover', kind: 'cover', prompt: 'Cover direction', targetPath: 'images/cover.png', aspect: '16:9' },
      { id: 'info', kind: 'infographic', prompt: 'Info direction', targetPath: 'images\\info.png', preset: 'infographic-default' },
    ]

    const result = await execute(ctx, 'md2wechat_plan_images', { manifestPath, images })
    expect(result.isError).toBe(false)
    const value = result.value as { revisionId: string; planId: string; planPath: string; items: unknown[]; locations: string[] }
    expect(value.planId).toMatch(/^[a-f0-9]{64}$/u)
    expect(value.planPath).toBe(`revisions/${value.revisionId}/plans/${value.planId}.json`)
    expect(value.items).toHaveLength(4)
    expect(value.locations).toContain(value.planPath)
    expect(JSON.stringify(result)).not.toContain('.trusted')
    const persisted = JSON.parse(decoder.decode(await store.read(value.planPath))) as { items: Array<Record<string, unknown>> }
    expect(persisted.items[0]).toMatchObject({ original: images[0], cliPlan: { mode: 'plan', side_effects: false } })
    expect(persisted.items[3]).toMatchObject({ original: { targetPath: 'images/info.png' } })
    expect(JSON.stringify(persisted)).not.toContain(workspace)
    const trustKey = `image-plans/${value.revisionId}/${value.planId}.json`
    const trusted = await store.readTrustedRecord(trustKey, 1024 * 1024)
    expect(JSON.parse(decoder.decode(trusted))).toMatchObject({
      schemaVersion: 1, revisionId: value.revisionId, planId: value.planId, planPath: value.planPath, items: persisted.items,
    })
    const originalWorkspaceIdentity = (JSON.parse(decoder.decode(trusted)) as { workspaceIdentity: string }).workspaceIdentity
    expect(originalWorkspaceIdentity).toMatch(/^[a-f0-9]{64}$/u)
    const articleProcessPath = await realpath(store.resolve(manifestPath.replace('manifest.json', 'article.md')))
    expect(gateway.calls.map(call => call.argv)).toEqual([
      ['generate_image', 'A mountain', '--aspect', '1:1', '--plan', '--json'],
      ['generate_image', '--preset', 'diagram', '--article', articleProcessPath, '--aspect', '4:3', '--plan', '--json'],
      ['generate_cover', '--article', articleProcessPath, '--aspect', '16:9', '--plan', '--json'],
      ['generate_infographic', '--article', articleProcessPath, '--preset', 'infographic-default', '--plan', '--json'],
    ])
    expect(gateway.calls.every(call => call.options?.env === undefined && call.options?.secrets === undefined)).toBe(true)
    expect(gateway.calls.every(call => call.options?.signal === signal && call.options.beforeSpawn !== undefined)).toBe(true)
    const rendered = (result.content[0] as { text: string }).text
    for (const item of images) {
      expect(rendered).toContain(item.id)
      expect(rendered).toContain(item.targetPath.replaceAll('\\', '/'))
    }
    expect(rendered).toContain('Prepared generate_image prompt')
    expect(rendered).not.toContain(workspace)

    const repeated = await execute(ctx, 'md2wechat_plan_images', { manifestPath, images })
    expect(repeated.value).toEqual(result.value)
    expect(await store.readTrustedRecord(trustKey, 1024 * 1024)).toEqual(trusted)

    const movedWorkspace = join(temporary, 'moved-workspace')
    await mkdir(movedWorkspace)
    const movedFs = createTestFileSystem(movedWorkspace)
    const movedStore = new ArtifactStore(movedFs as never, movedWorkspace, '.dsh/md2wechat')
    const movedSource = join(movedWorkspace, 'fixture.md')
    await writeFile(movedSource, '# Fixture\n\nBody.\n')
    const movedStart = await setupToolContext()
    movedStart.ctx.tools.register(createStartArticleTool({
      fs: movedFs as never,
      workspace: movedWorkspace,
      store: movedStore,
      now: () => new Date('2026-08-25T00:00:00.000Z'),
    }))
    const movedRevision = await execute(movedStart.ctx, 'md2wechat_start_article', { sourcePath: movedSource, title: 'Fixture' })
    expect(movedRevision.isError).toBe(false)
    expect((movedRevision.value as { manifestPath: string }).manifestPath).toBe(manifestPath)
    const movedPlanContext = await setupToolContext()
    movedPlanContext.ctx.tools.register(createPlanImagesTool({ gateway: new FakeGateway(), store: movedStore }))
    const movedPlan = await execute(movedPlanContext.ctx, 'md2wechat_plan_images', { manifestPath, images })
    expect(movedPlan.isError).toBe(false)
    expect((movedPlan.value as { planId: string }).planId).toBe(value.planId)
    const movedPlanPath = (movedPlan.value as { planPath: string }).planPath
    expect(decoder.decode(await movedStore.read(movedPlanPath))).not.toContain(movedWorkspace)
    const movedTrust = JSON.parse(decoder.decode(await movedStore.readTrustedRecord(
      `image-plans/${value.revisionId}/${value.planId}.json`, 1024 * 1024,
    ))) as { workspaceIdentity: string }
    expect(movedTrust.workspaceIdentity).not.toBe(originalWorkspaceIdentity)
    await movedPlanContext.dispose()
    await movedStart.dispose()
  })

  it('rejects duplicate IDs, unsafe targets, stale articles, and unsafe CLI plan responses', async () => {
    const manifestPath = await startFixtureArticle()
    const gateway = new FakeGateway(argv => {
      const response = validCliResponse(argv)
      return { ...response, data: { ...response.data, mode: 'execute', side_effects: true, requires_provider: true } }
    })
    ctx.tools.register(createPlanImagesTool({ gateway, store }))
    const base = { id: 'hero', kind: 'image' as const, prompt: 'Hero', targetPath: 'images/hero.png' }

    for (const images of [
      [base, base],
      [base, { ...base, id: 'alias', targetPath: 'images\\hero.png' }],
      [base, { ...base, id: 'case-alias', targetPath: 'images/HERO.png' }],
      [base, { ...base, id: 'HERO', targetPath: 'images/second.png' }],
      [{ ...base, targetPath: 'images/section' }, { ...base, id: 'child', targetPath: 'images/section/child.png' }],
      [{ ...base, targetPath: '../hero.png' }],
      [{ ...base, targetPath: '/tmp/hero.png' }],
      [{ ...base, targetPath: 'article.md' }],
      [{ ...base, targetPath: 'images/bad?.png' }],
      [{ ...base, targetPath: 'images/bad<.png' }],
      [{ ...base, targetPath: 'images/bad>.png' }],
      [{ ...base, targetPath: 'images/bad".png' }],
      [{ ...base, targetPath: 'images/bad|.png' }],
      [{ ...base, targetPath: 'images/bad*.png' }],
      [{ ...base, targetPath: 'images/bad:stream.png' }],
      [{ ...base, targetPath: 'images/control\u0001.png' }],
      [{ ...base, targetPath: 'images/CON.png' }],
      [{ ...base, id: 'bad/id' }],
      [{ ...base, id: 'bad\nid' }],
      [{ ...base, id: 'bad\u0001id' }],
      [{ ...base, id: 'bad\u001fid' }],
      [{ ...base, id: 'bad\u007fid' }],
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

  it('rejects an article replaced at the same path immediately before an image-plan spawn', async () => {
    const manifestPath = await startFixtureArticle()
    const articlePath = store.resolve(manifestPath.replace('manifest.json', 'article.md'))
    const gateway = new FakeGateway()
    gateway.beforeAuthorization = async () => {
      const replacement = join(workspace, 'replacement.md')
      await writeFile(replacement, '# Replacement before spawn\n')
      await rename(replacement, articlePath)
    }
    ctx.tools.register(createPlanImagesTool({ gateway, store }))

    const result = await execute(ctx, 'md2wechat_plan_images', {
      manifestPath,
      images: [{ id: 'hero', kind: 'image', prompt: 'Hero', targetPath: 'images/hero.png' }],
    })
    expect(result.isError).toBe(true)
    expect(gateway.calls).toHaveLength(0)
  })

  it('rejects a wrong image command projection before persisting a plan', async () => {
    const manifestPath = await startFixtureArticle()
    const gateway = new FakeGateway(argv => {
      const response = validCliResponse(argv)
      return { ...response, data: { ...response.data, command: 'generate_cover' } }
    })
    ctx.tools.register(createPlanImagesTool({ gateway, store }))

    const result = await execute(ctx, 'md2wechat_plan_images', {
      manifestPath,
      images: [{ id: 'hero', kind: 'image', prompt: 'Hero', targetPath: 'images/hero.png' }],
    })
    expect(result.isError).toBe(true)
    const revisionId = manifestPath.split('/')[1]!
    await expect(store.read(`revisions/${revisionId}/plans`)).rejects.toThrow()
  })

  it('rejects unknown image-plan response fields without leaking or persisting them', async () => {
    const manifestPath = await startFixtureArticle()
    const gateway = new FakeGateway(argv => {
      const response = validCliResponse(argv)
      return {
        ...response,
        data: {
          ...response.data,
          api_key: 'sk-secret-image',
          workspace_path: '/private/secret/image.png',
        },
      }
    })
    ctx.tools.register(createPlanImagesTool({ gateway, store }))

    const result = await execute(ctx, 'md2wechat_plan_images', {
      manifestPath,
      images: [{ id: 'hero', kind: 'image', prompt: 'Hero', targetPath: 'images/hero.png' }],
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain('sk-secret-image')
    expect(JSON.stringify(result)).not.toContain('/private/secret/image.png')
    const revisionId = manifestPath.split('/')[1]!
    await expect(store.read(`revisions/${revisionId}/plans`)).rejects.toThrow()
  })

  it('rejects a preset image plan that omits the authorized article path', async () => {
    const manifestPath = await startFixtureArticle()
    const gateway = new FakeGateway(argv => {
      const response = validCliResponse(argv)
      return { ...response, data: { ...response.data, article: '' } }
    })
    ctx.tools.register(createPlanImagesTool({ gateway, store }))

    const result = await execute(ctx, 'md2wechat_plan_images', {
      manifestPath,
      images: [{ id: 'cover', kind: 'cover', prompt: 'Cover', targetPath: 'images/cover.png' }],
    })
    expect(result.isError).toBe(true)
  })

  it('rejects combined validated image-plan output above the gateway one-megabyte cap', async () => {
    const manifestPath = await startFixtureArticle()
    const gateway = new FakeGateway(argv => {
      const response = validCliResponse(argv)
      return { ...response, data: { ...response.data, prompt: 'x'.repeat(600_000) } }
    })
    ctx.tools.register(createPlanImagesTool({ gateway, store }))

    const result = await execute(ctx, 'md2wechat_plan_images', {
      manifestPath,
      images: [
        { id: 'first', kind: 'image', prompt: 'First', targetPath: 'images/first.png' },
        { id: 'second', kind: 'image', prompt: 'Second', targetPath: 'images/second.png' },
      ],
    })
    expect(result.isError).toBe(true)
    expect(gateway.calls).toHaveLength(2)
  })

  it('serializes concurrent identical plan creation across separate stores without replacing bytes', async () => {
    const manifestPath = await startFixtureArticle()
    let renameCount = 0
    const trackedRename = async (source: string, destination: string): Promise<void> => {
      renameCount += 1
      await rename(source, destination)
    }
    const firstStore = new ArtifactStore(fs as never, workspace, '.dsh/md2wechat', { rename: trackedRename })
    const secondStore = new ArtifactStore(fs as never, workspace, '.dsh/md2wechat', { rename: trackedRename })
    const firstSetup = await setupToolContext()
    const secondSetup = await setupToolContext()
    firstSetup.ctx.tools.register(createPlanImagesTool({
      gateway: new FakeGateway(),
      store: firstStore, now: () => new Date('2026-08-25T04:00:00.000Z'),
    }))
    secondSetup.ctx.tools.register(createPlanImagesTool({
      gateway: new FakeGateway(), store: secondStore, now: () => new Date('2026-08-25T04:00:01.000Z'),
    }))
    const args = {
      manifestPath,
      images: [{ id: 'hero', kind: 'image' as const, prompt: 'Hero', targetPath: 'images/hero.png' }],
    }

    const [first, second] = await Promise.all([
      execute(firstSetup.ctx, 'md2wechat_plan_images', args),
      execute(secondSetup.ctx, 'md2wechat_plan_images', args),
    ])
    expect(first.isError).toBe(false)
    expect(second.isError).toBe(false)
    expect(second.value).toEqual(first.value)
    expect(renameCount).toBe(1)
    const planPath = (first.value as { planPath: string }).planPath
    const afterConcurrent = await firstStore.read(planPath)
    const replay = await execute(secondSetup.ctx, 'md2wechat_plan_images', args)
    expect(await secondStore.read(planPath)).toEqual(afterConcurrent)
    expect(replay.isError).toBe(false)
    expect(renameCount).toBe(1)
    await firstSetup.dispose()
    await secondSetup.dispose()
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
