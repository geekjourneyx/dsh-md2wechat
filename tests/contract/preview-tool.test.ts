import { mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CliEnvelope } from '../../src/cli/protocol.ts'
import type { CliGateway, CliRunOptions } from '../../src/cli/gateway.ts'
import { createPreviewTool } from '../../src/tools/preview.ts'
import { ArtifactStore } from '../../src/workspace/artifact-store.ts'
import { computeArticleRevision } from '../../src/workspace/revision.ts'
import type { ArticleManifest } from '../../src/workspace/revision.ts'
import { validateCurrentPreview } from '../../src/workspace/preview.ts'

interface TestTarget { targetKey: string; displayPath: string }
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const fixedNow = new Date('2026-08-25T00:00:00.000Z')

function createTestFileSystem(cwd: string) {
  return {
    async resolve(path: string): Promise<TestTarget> {
      const displayPath = resolve(cwd, path)
      let ancestor = displayPath
      const missing: string[] = []
      while (true) {
        try { return { displayPath, targetKey: join(await realpath(ancestor), ...missing) } } catch (error) {
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
        return { version: `${info.mtimeMs}:${info.size}`, type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other', size: info.size }
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
        throw error
      }
    },
    async readBytes(target: TestTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
      signal?.throwIfAborted()
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
        throw error
      }
    },
  }
}

async function listRegularFiles(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) files.push(...await listRegularFiles(join(root, entry.name), relativePath))
    else if (entry.isFile()) files.push(relativePath)
  }
  return files.sort()
}

interface FixtureAsset {
  index: number
  kind: 'local' | 'online' | 'ai'
  source: string
  resolved_source?: string
  exists: boolean
}

function inspectFixture(articlePath: string, assets: readonly FixtureAsset[] = []): Record<string, unknown> {
  const counts = {
    total: assets.length,
    local: assets.filter(asset => asset.kind === 'local').length,
    remote: assets.filter(asset => asset.kind === 'online').length,
    ai: assets.filter(asset => asset.kind === 'ai').length,
  }
  const checks = [
    { level: 'warn', code: 'DUPLICATE_H1', message: 'Body H1 matches the final article title', field: 'title', suggested_fix: 'remove the body H1' },
    ...(assets.length === 0 ? [] : [{
      level: 'info', code: 'IMAGE_REPLACEMENT_REQUIRES_UPLOAD_OR_DRAFT', message: 'Images require a publishing flow', field: 'images', suggested_fix: 'use upload or draft',
    }]),
  ]
  return {
    source_file: articlePath,
    source_dir: dirname(articlePath),
    context: { mode: 'api', theme: 'default', font_size: 'medium', background_type: 'none', custom_prompt: false, upload: false, draft: false },
    metadata: {
      title: { value: 'Fixture', source: 'markdown.heading', limit: 32, length: 7, valid: true },
      author: { value: '', source: 'fallback.empty', limit: 16, length: 0, valid: true },
      digest: { value: '', source: 'fallback.empty', limit: 128, length: 0, valid: true },
    },
    structure: {
      body_h1: { present: true, text: 'Fixture' }, duplicate_title_risk: true,
      headings: [{ level: 1, text: 'Fixture' }], images: counts,
    },
    ...(assets.length === 0 ? {} : { assets }),
    readiness: {
      convert_ready: true, upload_ready: false, draft_ready: false, preview_fidelity: 'exact', schema_version: 'v1',
      targets: { preview: 'ready', convert: 'ready', upload: 'not_requested', draft: 'not_requested' }, blockers: [],
    },
    checks,
  }
}

function mutableRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>
}

function mutateInspectResponse(response: CliEnvelope, mutate: (inspect: Record<string, unknown>) => void): CliEnvelope {
  const copy = structuredClone(response)
  mutate(mutableRecord(mutableRecord(copy.data).inspect))
  return copy
}

class PreviewGateway implements CliGateway {
  readonly calls: Array<{ argv: readonly string[]; options?: CliRunOptions }> = []
  beforeSpawn?: (argv: readonly string[], options?: CliRunOptions) => void | Promise<void>
  mutate?: (response: CliEnvelope) => CliEnvelope
  html = '<article>preview</article>'
  includeLocalImage = true
  fixtureAssets?: readonly FixtureAsset[]
  resolve(): Promise<string> { return Promise.resolve('/fixture/md2wechat') }
  async run(argv: readonly string[], options?: CliRunOptions): Promise<CliEnvelope> {
    await this.beforeSpawn?.(argv, options)
    if (options?.beforeSpawn !== undefined) await options.beforeSpawn(options.signal ?? new AbortController().signal)
    this.calls.push({ argv: [...argv], options })
    const output = argv[argv.indexOf('--output') + 1]!
    await writeFile(output, this.html)
    const article = argv[1]!
    const assets = this.fixtureAssets ?? (this.includeLocalImage
      ? [{ index: 0, kind: 'local' as const, source: 'images/hero.png', resolved_source: join(dirname(article), 'images/hero.png'), exists: true }]
      : [])
    const response: CliEnvelope = {
      success: true, code: 'PREVIEW_READY', message: 'Preview ready', schema_version: 'v1', status: 'completed', retryable: false,
      data: { output_file: output, inspect: inspectFixture(article, assets), render: { mode: 'api', theme: 'default', fidelity: 'exact', exact_html: true } },
    }
    return this.mutate?.(response) ?? response
  }
}

describe('md2wechat_preview', () => {
  let temporary: string
  let workspace: string
  let fs: ReturnType<typeof createTestFileSystem>
  let store: ArtifactStore
  let manifestPath: string
  let revisionId: string
  let articlePath: string
  let imagePath: string
  let approvalRequests: Array<Record<string, unknown>>
  let resolvedReferences: string[]
  let approvalOutcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
  const credentialReference = 'MD2WECHAT_API_KEY'
  const credentialValue = 'top-secret-preview-key'
  const agent = { id: 'agent-fixture' } as never

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'dsh-md2wechat-preview-tool-'))
    workspace = join(temporary, 'workspace')
    await mkdir(workspace)
    fs = createTestFileSystem(workspace)
    store = new ArtifactStore(fs as never, workspace, '.dsh/md2wechat')
    await installArticle('# Fixture\n\n![hero](images/hero.png)\n', { 'images/hero.png': Uint8Array.from([137, 80, 78, 71]) })
    approvalRequests = []
    resolvedReferences = []
    approvalOutcome = 'allowed-once'
  })

  async function installArticle(markdown: string, images: Readonly<Record<string, Uint8Array>> = {}): Promise<void> {
    const article = encoder.encode(markdown)
    const manifest: ArticleManifest = { schemaVersion: 1, articlePath: 'article.md', manifestPath: 'manifest.json', createdAt: fixedNow.toISOString(), title: 'Fixture' }
    const revision = computeArticleRevision(article, manifest)
    revisionId = revision.id
    articlePath = `revisions/${revisionId}/article.md`
    manifestPath = `revisions/${revisionId}/manifest.json`
    imagePath = `revisions/${revisionId}/images/hero.png`
    await store.writeAtomic(articlePath, article)
    await store.writeAtomic(manifestPath, encoder.encode(`${JSON.stringify(manifest)}\n`))
    for (const [relativePath, bytes] of Object.entries(images)) {
      await store.writeAtomic(`revisions/${revisionId}/${relativePath}`, bytes)
    }
  }

  afterEach(async () => {
    await import('node:fs/promises').then(nodeFs => nodeFs.rm(temporary, { recursive: true, force: true }))
  })

  function dependencies(gateway: CliGateway, selectedStore = store) {
    return {
      gateway,
      store: selectedStore,
      layoutBaseUrl: 'https://www.md2wechat.cn',
      credentialRefs: { MD2WECHAT_API_KEY: credentialReference },
      credentials: {
        resolve(reference: string) {
          resolvedReferences.push(reference)
          return Promise.resolve({ value: credentialValue, source: 'test' })
        },
      },
      approval: {
        request(request: Record<string, unknown>) {
          approvalRequests.push(request)
          return Promise.resolve(approvalOutcome)
        },
      },
      now: () => new Date(fixedNow),
      previewTtlMs: 10 * 60 * 1000,
      previewTheme: 'default',
      previewFontSize: 'medium' as const,
      previewBackgroundType: 'none' as const,
      reportAuditFailure() {},
    }
  }

  function exec(signal = new AbortController().signal, withAgent = true) {
    return {
      signal, callId: 'preview-call' as never, name: 'md2wechat_preview', arguments: { manifestPath },
      rootCallId: 'preview-call' as never, token: Symbol('preview') as never,
      ...(withAgent ? { agent } : {}), deferContext() {}, concludeTurn() {},
    }
  }

  async function currentSnapshotInput(layoutBaseUrl = 'https://www.md2wechat.cn') {
    return {
      revisionId,
      articlePath,
      articleBytes: await store.read(articlePath),
      localImages: [{ path: imagePath, bytes: await store.read(imagePath) }],
      layoutBaseUrl,
      previewSettings: { mode: 'api' as const, theme: 'default', fontSize: 'medium' as const, backgroundType: 'none' as const, output: 'standalone-html' },
      credentialReference,
      credentialValue,
      pluginVersion: '1.0.0',
      cliVersion: '3.3.0',
    }
  }

  it('uses one approval, one credential, exact command and isolated environment, then commits only safe artifacts', async () => {
    const gateway = new PreviewGateway()
    const tool = createPreviewTool(dependencies(gateway))
    const execution = exec()
    const result = await tool.execute({ manifestPath }, execution)

    expect(approvalRequests).toHaveLength(1)
    expect(approvalRequests[0]).toMatchObject({ agent, toolName: 'md2wechat_preview', callId: 'preview-call' })
    expect(approvalRequests[0]?.signal).toBe(execution.signal)
    expect(resolvedReferences).toEqual([credentialReference])
    expect(gateway.calls).toHaveLength(1)
    const call = gateway.calls[0]!
    const articleProcessPath = await realpath(store.resolve(articlePath))
    expect(call.argv).toEqual([
      'preview', articleProcessPath,
      '--mode', 'api',
      '--theme', 'default',
      '--font-size', 'medium',
      '--background-type', 'none',
      '--output', expect.any(String),
      '--json',
    ])
    expect(isAbsolute(call.argv[11]!)).toBe(true)
    expect(call.options?.env).toEqual({ MD2WECHAT_API_KEY: credentialValue, MD2WECHAT_BASE_URL: 'https://www.md2wechat.cn' })
    expect(call.options?.secrets).toEqual([credentialValue])
    expect(call.options?.beforeSpawn).toBeTypeOf('function')

    expect(result).toMatchObject({ revisionId, manifestPath, pluginVersion: '1.0.0', cliVersion: '3.3.0' })
    expect(result).not.toHaveProperty('previewUrl')
    expect(result.previewHtmlPath).toMatch(new RegExp(`^revisions/${revisionId}/previews/html/[a-f0-9]{64}\\.html$`, 'u'))
    expect(result.previewReceiptId).toMatch(/^[a-f0-9]{64}$/u)
    expect(decoder.decode(await store.read(result.previewHtmlPath as string))).toBe(gateway.html)
    const operations = decoder.decode(await store.read(`revisions/${revisionId}/operations.jsonl`))
    expect(operations).toContain('preview')
    const everything = JSON.stringify(result) + operations + decoder.decode(await store.read(`revisions/${revisionId}/previews/current.json`))
    expect(everything).not.toContain(credentialValue)
    expect(everything).not.toContain(credentialReference)
    expect(everything).not.toContain(workspace)

    const current = await validateCurrentPreview(store, {
      snapshotInput: {
        revisionId, articlePath, articleBytes: await store.read(articlePath),
        localImages: [{ path: imagePath, bytes: await store.read(imagePath) }],
        layoutBaseUrl: 'https://www.md2wechat.cn',
        previewSettings: { mode: 'api', theme: 'default', fontSize: 'medium', backgroundType: 'none', output: 'standalone-html' },
        credentialReference, credentialValue, pluginVersion: '1.0.0', cliVersion: '3.3.0',
      },
      credentialValue,
      now: new Date('2026-08-25T00:05:00.000Z'),
    })
    expect(current.receipt.id).toBe(result.previewReceiptId)
  })

  it.each(['rejected', 'cancelled', 'unavailable'] as const)('fails closed for %s without resolving or spawning', async (outcome) => {
    approvalOutcome = outcome
    const gateway = new PreviewGateway()
    const tool = createPreviewTool(dependencies(gateway))
    await expect(tool.execute({ manifestPath }, exec())).rejects.toThrow(
      outcome === 'cancelled' ? 'article preview cancelled' : `approval ${outcome}`,
    )
    expect(approvalRequests).toHaveLength(1)
    expect(resolvedReferences).toHaveLength(0)
    expect(gateway.calls).toHaveLength(0)
  })

  it('rejects missing agent, unknown input, missing credential, and cancellation before approval', async () => {
    const gateway = new PreviewGateway()
    await expect(createPreviewTool(dependencies(gateway)).execute({ manifestPath }, exec(undefined, false))).rejects.toThrow('active agent')
    await expect(createPreviewTool(dependencies(gateway)).execute({ manifestPath, unexpected: true } as never, exec())).rejects.toThrow('unknown')
    const missing = dependencies(gateway)
    missing.credentialRefs = {}
    await expect(createPreviewTool(missing).execute({ manifestPath }, exec())).rejects.toThrow('not configured')
    const controller = new AbortController()
    controller.abort(new Error('cancelled before preview'))
    await expect(createPreviewTool(dependencies(gateway)).execute({ manifestPath }, exec(controller.signal))).rejects.toThrow()
    expect(gateway.calls).toHaveLength(0)
  })

  it('requires a safe audit-failure reporter before registering the tool', () => {
    const missingReporter = dependencies(new PreviewGateway()) as Partial<ReturnType<typeof dependencies>>
    delete missingReporter.reportAuditFailure
    expect(() => createPreviewTool(missingReporter as ReturnType<typeof dependencies>)).toThrow('audit')
  })

  it('revalidates article and every local image immediately before spawn', async () => {
    const gateway = new PreviewGateway()
    gateway.beforeSpawn = async () => { await store.writeAtomic(imagePath, Uint8Array.from([0])) }
    const tool = createPreviewTool(dependencies(gateway))
    await expect(tool.execute({ manifestPath }, exec())).rejects.toThrow('article preview failed')
    expect(gateway.calls).toHaveLength(0)
    await expect(store.read(`revisions/${revisionId}/previews/current.json`)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('accepts exact md2wechat 3.3.0 remote and generated asset projections in Markdown order', async () => {
    await installArticle([
      '# Fixture',
      '![remote](https://example.com/image.png)',
      '![generated](__generate:draw a cat__)',
    ].join('\n'))
    const gateway = new PreviewGateway()
    gateway.includeLocalImage = false
    gateway.fixtureAssets = [
      { index: 0, kind: 'online', source: 'https://example.com/image.png', exists: true },
      { index: 1, kind: 'ai', source: 'draw a cat', exists: true },
    ]
    const result = await createPreviewTool(dependencies(gateway)).execute({ manifestPath }, exec())
    expect(result.revisionId).toBe(revisionId)
  })

  it.each([
    ['missing file', '![missing](images/missing.png)'],
    ['revision escape', '![escape](../outside.png)'],
    ['absolute path', '![absolute](/private/image.png)'],
    ['duplicate alias', '![one](images/hero.png)\n![two](./images/hero.png)'],
    ['reference syntax', '![reference][hero]\n[hero]: images/hero.png'],
    ['ambiguous query', '![query](images/hero.png?size=2)'],
    ['file URL', '![file](file:///private/image.png)'],
    ['data URL', '![data](data:image/png;base64,AAAA)'],
    ['fragment', '![fragment](#existing-image)'],
    ['protocol-relative URL', '![remote](//example.com/image.png)'],
  ] as const)('rejects unsafe or unsupported local image input before approval: %s', async (_name, imageMarkdown) => {
    await installArticle(`# Fixture\n\n${imageMarkdown}\n`, { 'images/hero.png': Uint8Array.from([1]) })
    const gateway = new PreviewGateway()
    await expect(createPreviewTool(dependencies(gateway)).execute({ manifestPath }, exec())).rejects.toThrow()
    expect(approvalRequests).toHaveLength(0)
    expect(resolvedReferences).toHaveLength(0)
    expect(gateway.calls).toHaveLength(0)
  })

  it('rejects a local image symlink that escapes its immutable revision before approval', async () => {
    await installArticle('# Fixture\n\n![escape](images/outside.png)\n')
    const outside = join(temporary, 'outside.png')
    await writeFile(outside, 'outside')
    await mkdir(dirname(store.resolve(`revisions/${revisionId}/images/outside.png`)), { recursive: true })
    await symlink(outside, store.resolve(`revisions/${revisionId}/images/outside.png`))
    await expect(createPreviewTool(dependencies(new PreviewGateway())).execute({ manifestPath }, exec())).rejects.toThrow()
    expect(approvalRequests).toHaveLength(0)
  })

  it('rejects a control-bearing local image destination before approval even when the file exists', async () => {
    const destination = 'images/control\u0001.png'
    await installArticle(`# Fixture\n\n![control](${destination})\n`, { [destination]: Uint8Array.from([1]) })
    await expect(createPreviewTool(dependencies(new PreviewGateway())).execute({ manifestPath }, exec())).rejects.toThrow('article preview failed')
    expect(approvalRequests).toHaveLength(0)
  })

  it('cancels while awaiting approval without resolving credentials or spawning', async () => {
    const controller = new AbortController()
    let approvalStarted!: () => void
    const started = new Promise<void>(resolveStarted => { approvalStarted = resolveStarted })
    const deps = dependencies(new PreviewGateway())
    deps.approval.request = request => new Promise(resolveOutcome => {
      approvalRequests.push(request)
      approvalStarted()
      const requestSignal = request.signal as AbortSignal
      requestSignal.addEventListener('abort', () => resolveOutcome('cancelled'), { once: true })
    })
    const pending = createPreviewTool(deps).execute({ manifestPath }, exec(controller.signal))
    await started
    controller.abort(new Error('cancel awaiting approval'))
    await expect(pending).rejects.toThrow('article preview cancelled')
    expect(resolvedReferences).toHaveLength(0)
  })

  it('cleans cancellation before spawn, during CLI execution, and during publication', async () => {
    for (const phase of ['before-spawn', 'during-cli', 'publication'] as const) {
      const controller = new AbortController()
      const gateway = new PreviewGateway()
      let selectedStore = store
      if (phase === 'before-spawn') gateway.beforeSpawn = () => { controller.abort(new Error('cancel before spawn')) }
      if (phase === 'during-cli') {
        gateway.run = async (argv, options) => {
          if (options?.beforeSpawn !== undefined) await options.beforeSpawn(options.signal ?? controller.signal)
          gateway.calls.push({ argv, options })
          controller.abort(new Error('cancel during CLI'))
          throw controller.signal.reason
        }
      }
      if (phase === 'publication') {
        selectedStore = new ArtifactStore(fs as never, workspace, '.dsh/md2wechat', {
          beforeNativeCommit({ destinationPath }) {
            if (destinationPath.includes('/previews/snapshots/')) controller.abort(new Error('cancel publication'))
          },
        })
      }
      await expect(createPreviewTool(dependencies(gateway, selectedStore)).execute({ manifestPath }, exec(controller.signal))).rejects.toThrow('cancel')
      await expect(store.read(`revisions/${revisionId}/previews/current.json`)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    }
  })

  it.each([
    ['wrong code', (response: CliEnvelope) => ({ ...response, code: 'PREVIEW_ACTION_REQUIRED' })],
    ['unknown data', (response: CliEnvelope) => ({ ...response, data: { ...response.data, api_key: credentialValue } })],
    ['unknown inspect', (response: CliEnvelope) => ({ ...response, data: { ...response.data, inspect: { ...(response.data?.inspect as object), injected: workspace } } })],
    ['wrong output', (response: CliEnvelope) => ({ ...response, data: { ...response.data, output_file: '/private/wrong.html' } })],
    ['wrong render', (response: CliEnvelope) => ({ ...response, data: { ...response.data, render: { mode: 'ai', theme: 'default', fidelity: 'exact', exact_html: true } } })],
  ] as const)('rejects %s without publishing or leaking the response', async (_name, mutate) => {
    const gateway = new PreviewGateway()
    gateway.mutate = mutate
    const tool = createPreviewTool(dependencies(gateway))
    let failure: unknown
    try {
      await tool.execute({ manifestPath }, exec())
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).not.toContain(credentialValue)
    expect(String(failure)).not.toContain(workspace)
    await expect(store.read(`revisions/${revisionId}/previews/current.json`)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it.each([
    ['configured render', (inspect: Record<string, unknown>) => {
      mutableRecord(inspect.context).theme = 'grace'
    }, (response: CliEnvelope) => {
      const copy = structuredClone(response)
      mutableRecord(mutableRecord(copy.data).render).theme = 'grace'
      return copy
    }],
    ['font size enum', (inspect: Record<string, unknown>) => { mutableRecord(inspect.context).font_size = 'huge' }],
    ['background enum', (inspect: Record<string, unknown>) => { mutableRecord(inspect.context).background_type = 'paper' }],
    ['metadata source enum', (inspect: Record<string, unknown>) => { mutableRecord(mutableRecord(inspect.metadata).title).source = 'hostile.source' }],
    ['metadata length relation', (inspect: Record<string, unknown>) => { mutableRecord(mutableRecord(inspect.metadata).title).length = 99 }],
    ['heading level', (inspect: Record<string, unknown>) => {
      mutableRecord((mutableRecord(inspect.structure).headings as unknown[])[0]).level = 0
    }],
    ['image counter relation', (inspect: Record<string, unknown>) => { mutableRecord(mutableRecord(inspect.structure).images).total = 2 }],
    ['asset index', (inspect: Record<string, unknown>) => { mutableRecord((inspect.assets as unknown[])[0]).index = 7 }],
    ['asset kind', (inspect: Record<string, unknown>) => { mutableRecord((inspect.assets as unknown[])[0]).kind = 'online' }],
    ['asset source', (inspect: Record<string, unknown>) => { mutableRecord((inspect.assets as unknown[])[0]).source = 'images/other.png' }],
    ['asset exists', (inspect: Record<string, unknown>) => { mutableRecord((inspect.assets as unknown[])[0]).exists = false }],
    ['readiness target enum', (inspect: Record<string, unknown>) => { mutableRecord(mutableRecord(inspect.readiness).targets).preview = 'degraded' }],
    ['diagnostic level enum', (inspect: Record<string, unknown>) => {
      inspect.checks = [{ level: 'fatal', code: 'DUPLICATE_H1', message: 'unsafe' }]
    }],
    ['diagnostic relation to inputs', (inspect: Record<string, unknown>) => {
      inspect.checks = [{ level: 'error', code: 'LOCAL_IMAGE_UNSUPPORTED_FORMAT', message: 'unsafe', field: 'images', suggested_fix: 'unsafe' }]
      mutableRecord(inspect.readiness).blockers = [{
        level: 'error', code: 'LOCAL_IMAGE_UNSUPPORTED_FORMAT', message: 'unsafe', field: 'images', suggested_fix: 'unsafe', blocks: ['upload', 'draft'],
      }]
    }],
    ['blocker relation', (inspect: Record<string, unknown>) => {
      mutableRecord(inspect.readiness).blockers = [{ level: 'error', code: 'TITLE_TOO_LONG', message: 'unsafe', blocks: ['convert'] }]
    }],
    ['convert readiness relation', (inspect: Record<string, unknown>) => {
      mutableRecord(inspect.readiness).convert_ready = false
      mutableRecord(mutableRecord(inspect.readiness).targets).convert = 'blocked'
    }],
  ] as const)('rejects hostile nested CLI value: %s', async (_name, mutateInspect, mutateEnvelope) => {
    const gateway = new PreviewGateway()
    gateway.mutate = response => {
      const inspected = mutateInspectResponse(response, mutateInspect)
      return mutateEnvelope?.(inspected) ?? inspected
    }
    await expect(createPreviewTool(dependencies(gateway)).execute({ manifestPath }, exec())).rejects.toThrow()
    await expect(store.read(`revisions/${revisionId}/previews/current.json`)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('redacts raw gateway failures before they reach the tool result', async () => {
    const gateway = new PreviewGateway()
    gateway.run = async (argv, options) => {
      if (options?.beforeSpawn !== undefined) await options.beforeSpawn(options.signal ?? new AbortController().signal)
      throw new Error(`provider failed: ${credentialValue} ${credentialReference} ${workspace} ${argv[argv.indexOf('--output') + 1]}`)
    }
    let failure: unknown
    try {
      await createPreviewTool(dependencies(gateway)).execute({ manifestPath }, exec())
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    const text = String(failure)
    expect(text).not.toContain(credentialValue)
    expect(text).not.toContain(credentialReference)
    expect(text).not.toContain(workspace)
    expect(text).not.toContain('.staging')
  })

  it.each(['pre-approval read', 'credential provider', 'queue identity', 'staging'] as const)(
    'sanitizes %s failures without exposing paths, references, or raw reasons',
    async (phase) => {
      const marker = `raw-${phase.replaceAll(' ', '-')}`
      const gateway = new PreviewGateway()
      let selectedStore = store
      const deps = dependencies(gateway)
      if (phase === 'pre-approval read') {
        selectedStore = Object.create(store) as ArtifactStore
        selectedStore.read = () => Promise.reject(new Error(`${marker} ${workspace} ${credentialReference}`))
      }
      if (phase === 'credential provider') {
        deps.credentials.resolve = () => Promise.reject(new Error(`${marker} ${workspace} ${credentialReference}`))
      }
      if (phase === 'queue identity') {
        selectedStore = Object.create(store) as ArtifactStore
        selectedStore.canonicalIdentity = () => Promise.reject(new Error(`${marker} ${workspace} ${credentialReference}`))
      }
      if (phase === 'staging') {
        selectedStore = Object.create(store) as ArtifactStore
        selectedStore.stageOutput = () => Promise.reject(new Error(`${marker} ${workspace} ${credentialReference}`))
      }
      deps.store = selectedStore
      const failure = await createPreviewTool(deps).execute({ manifestPath }, exec()).catch((error: unknown) => error)
      const text = String(failure)
      expect(failure).toBeInstanceOf(Error)
      expect(text).not.toContain(marker)
      expect(text).not.toContain(workspace)
      expect(text).not.toContain(credentialReference)
    },
  )

  it('classifies cancellation without exposing its raw reason', async () => {
    const controller = new AbortController()
    controller.abort(new Error(`raw-cancellation ${workspace} ${credentialReference}`))
    const failure = await createPreviewTool(dependencies(new PreviewGateway()))
      .execute({ manifestPath }, exec(controller.signal))
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toBe('Error: article preview cancelled')
  })

  it.each(['missing', 'empty', 'oversized', 'directory'] as const)('rejects %s staged HTML output and cleans it', async (kind) => {
    const gateway = new PreviewGateway()
    gateway.run = async (argv, options) => {
      if (options?.beforeSpawn !== undefined) await options.beforeSpawn(options.signal ?? new AbortController().signal)
      gateway.calls.push({ argv, options })
      const output = argv[argv.indexOf('--output') + 1]!
      if (kind === 'empty') await writeFile(output, '')
      if (kind === 'oversized') await writeFile(output, Buffer.alloc(8 * 1024 * 1024 + 1, 65))
      if (kind === 'directory') await mkdir(output)
      return {
        success: true, code: 'PREVIEW_READY', message: 'Preview ready', schema_version: 'v1', status: 'completed', retryable: false,
        data: { output_file: output, inspect: inspectFixture(argv[1]!, join(dirname(argv[1]!), 'images/hero.png')), render: { mode: 'api', theme: 'default', fidelity: 'exact', exact_html: true } },
      }
    }
    await expect(createPreviewTool(dependencies(gateway)).execute({ manifestPath }, exec())).rejects.toThrow()
    await expect(store.read(`revisions/${revisionId}/previews/current.json`)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('preserves the last committed preview when a replacement fails during each publication phase', async () => {
    const first = await createPreviewTool(dependencies(new PreviewGateway())).execute({ manifestPath }, exec())
    const priorPointer = await store.read(`revisions/${revisionId}/previews/current.json`)
    const priorHtml = await store.read(first.previewHtmlPath as string)
    const previewRoot = store.resolve(`revisions/${revisionId}/previews`)
    const priorFiles = await listRegularFiles(previewRoot)

    for (const phase of ['/previews/html/', '/previews/snapshots/', '/previews/receipts/', '/previews/current.json']) {
      const failingStore = new ArtifactStore(fs as never, workspace, '.dsh/md2wechat', {
        beforeNativeCommit({ destinationPath }) {
          if (destinationPath.includes(phase)) throw new Error(`injected ${phase} failure`)
        },
      })
      const gateway = new PreviewGateway()
      gateway.html = `<article>${phase}</article>`
      const deps = { ...dependencies(gateway, failingStore), layoutBaseUrl: `https://changed.example/${encodeURIComponent(phase)}` }
      await expect(createPreviewTool(deps).execute({ manifestPath }, exec())).rejects.toThrow('article preview failed')
      expect(await store.read(`revisions/${revisionId}/previews/current.json`)).toEqual(priorPointer)
      expect(await store.read(first.previewHtmlPath as string)).toEqual(priorHtml)
      expect(await listRegularFiles(previewRoot)).toEqual(priorFiles)
    }
  })

  it('does not delete prior shared snapshot and HTML when a same-input receipt replacement fails', async () => {
    const first = await createPreviewTool(dependencies(new PreviewGateway())).execute({ manifestPath }, exec())
    const firstHtml = await store.read(first.previewHtmlPath as string)
    const failingStore = new ArtifactStore(fs as never, workspace, '.dsh/md2wechat', {
      beforeNativeCommit({ destinationPath }) {
        if (destinationPath.endsWith('/previews/current.json')) throw new Error('injected current-pointer failure')
      },
    })
    const replacement = dependencies(new PreviewGateway(), failingStore)
    replacement.now = () => new Date('2026-08-25T00:01:00.000Z')
    await expect(createPreviewTool(replacement).execute({ manifestPath }, exec())).rejects.toThrow('article preview failed')
    expect(Array.from(await store.read(first.previewHtmlPath as string))).toEqual(Array.from(firstHtml))
    await expect(validateCurrentPreview(store, {
      snapshotInput: {
        revisionId, articlePath, articleBytes: await store.read(articlePath),
        localImages: [{ path: imagePath, bytes: await store.read(imagePath) }],
        layoutBaseUrl: 'https://www.md2wechat.cn', previewSettings: { mode: 'api', theme: 'default', fontSize: 'medium', backgroundType: 'none', output: 'standalone-html' },
        credentialReference, credentialValue, pluginVersion: '1.0.0', cliVersion: '3.3.0',
      },
      credentialValue,
      now: new Date('2026-08-25T00:05:00.000Z'),
    })).resolves.toMatchObject({ receipt: { id: first.previewReceiptId } })
  })

  it.each(['gateway', 'response', 'html'] as const)(
    'preserves a prior same-snapshot current preview when replacement %s validation fails',
    async (phase) => {
      const first = await createPreviewTool(dependencies(new PreviewGateway())).execute({ manifestPath }, exec())
      const gateway = new PreviewGateway()
      if (phase === 'gateway') {
        gateway.run = async (argv, options) => {
          if (options?.beforeSpawn !== undefined) await options.beforeSpawn(options.signal ?? new AbortController().signal)
          throw new Error('replacement gateway failure')
        }
      }
      if (phase === 'response') gateway.mutate = response => ({ ...response, code: 'PREVIEW_ACTION_REQUIRED' })
      if (phase === 'html') gateway.html = ''
      const replacement = dependencies(gateway)
      replacement.now = () => new Date('2026-08-25T00:01:00.000Z')

      await expect(createPreviewTool(replacement).execute({ manifestPath }, exec())).rejects.toThrow()
      await expect(validateCurrentPreview(store, {
        snapshotInput: await currentSnapshotInput(),
        credentialValue,
        now: new Date('2026-08-25T00:05:00.000Z'),
      })).resolves.toMatchObject({ receipt: { id: first.previewReceiptId } })
    },
  )

  it.each(['prepared', 'html-published', 'snapshot-published', 'receipt-published'] as const)(
    'never removes artifacts from committed A or B when retry A fails after %s',
    async (phase) => {
      const firstGateway = new PreviewGateway()
      firstGateway.html = '<article>A</article>'
      const first = await createPreviewTool(dependencies(firstGateway)).execute({ manifestPath }, exec())
      const firstPointer = JSON.parse(decoder.decode(await store.read(`revisions/${revisionId}/previews/current.json`))) as {
        snapshotPath: string; receiptPath: string; previewHtmlPath: string
      }

      const secondGateway = new PreviewGateway()
      secondGateway.html = '<article>B</article>'
      const secondDeps = { ...dependencies(secondGateway), layoutBaseUrl: 'https://layout-b.example', now: () => new Date('2026-08-25T00:01:00.000Z') }
      await createPreviewTool(secondDeps).execute({ manifestPath }, exec())
      const currentPath = `revisions/${revisionId}/previews/current.json`
      const secondPointerBytes = await store.read(currentPath)
      const secondPointer = JSON.parse(decoder.decode(secondPointerBytes)) as {
        snapshotPath: string; receiptPath: string; previewHtmlPath: string
      }
      const protectedPaths = [...new Set([
        firstPointer.snapshotPath, firstPointer.receiptPath, firstPointer.previewHtmlPath,
        secondPointer.snapshotPath, secondPointer.receiptPath, secondPointer.previewHtmlPath,
      ])]
      const protectedBytes = new Map<string, Uint8Array>()
      for (const path of protectedPaths) protectedBytes.set(path, await store.read(path))
      const filesBeforeRetry = await listRegularFiles(store.resolve(`revisions/${revisionId}/previews`))

      const retryGateway = new PreviewGateway()
      retryGateway.html = '<article>A</article>'
      let retryStore = new ArtifactStore(fs as never, workspace, '.dsh/md2wechat')
      if (phase === 'prepared') {
        retryGateway.run = async (_argv, options) => {
          if (options?.beforeSpawn !== undefined) await options.beforeSpawn(options.signal ?? new AbortController().signal)
          throw new Error('retry A prepared failure')
        }
      }
      if (phase === 'html-published') {
        let identityCalls = 0
        const originalIdentity = retryStore.canonicalIdentity.bind(retryStore)
        retryStore.canonicalIdentity = async (path, signal) => {
          identityCalls++
          if (identityCalls === 2) throw new Error('retry A failure after HTML publication')
          return originalIdentity(path, signal)
        }
      }
      if (phase === 'snapshot-published') {
        retryStore = new ArtifactStore(fs as never, workspace, '.dsh/md2wechat', {
          beforeNativeCommit({ destinationPath }) {
            if (destinationPath.includes('/previews/receipts/')) throw new Error('retry A failure after snapshot publication')
          },
        })
      }
      if (phase === 'receipt-published') {
        retryStore = new ArtifactStore(fs as never, workspace, '.dsh/md2wechat', {
          beforeNativeCommit({ destinationPath }) {
            if (destinationPath.endsWith('/previews/current.json')) throw new Error('retry A failure after receipt publication')
          },
        })
      }
      const retryDeps = {
        ...dependencies(retryGateway, retryStore),
        now: () => new Date('2026-08-25T00:02:00.000Z'),
      }
      await expect(createPreviewTool(retryDeps).execute({ manifestPath }, exec())).rejects.toThrow('article preview failed')

      expect(await store.read(currentPath)).toEqual(secondPointerBytes)
      for (const [path, bytes] of protectedBytes) expect(await store.read(path)).toEqual(bytes)
      expect(await listRegularFiles(store.resolve(`revisions/${revisionId}/previews`))).toEqual(filesBeforeRetry)
      expect(first.previewHtmlPath).toBe(firstPointer.previewHtmlPath)
    },
  )

  it('returns the committed preview when operation history append fails and reports a safe audit warning', async () => {
    const auditWarnings: string[] = []
    const failingStore = new ArtifactStore(fs as never, workspace, '.dsh/md2wechat', {
      beforeNativeCommit({ destinationPath }) {
        if (destinationPath.endsWith('/operations.jsonl')) throw new Error(`raw-audit ${workspace} ${credentialReference}`)
      },
    })
    const deps = {
      ...dependencies(new PreviewGateway(), failingStore),
      reportAuditFailure(message: string) { auditWarnings.push(message) },
    }
    const result = await createPreviewTool(deps).execute({ manifestPath }, exec())
    expect(auditWarnings).toEqual(['article preview operation history could not be recorded'])
    await expect(validateCurrentPreview(store, {
      snapshotInput: await currentSnapshotInput(),
      credentialValue,
      now: new Date('2026-08-25T00:05:00.000Z'),
    })).resolves.toMatchObject({ receipt: { id: result.previewReceiptId } })
  })

  it('keeps a committed preview successful when the audit warning reporter also fails', async () => {
    const failingStore = new ArtifactStore(fs as never, workspace, '.dsh/md2wechat', {
      beforeNativeCommit({ destinationPath }) {
        if (destinationPath.endsWith('/operations.jsonl')) throw new Error(`raw-audit ${workspace} ${credentialReference}`)
      },
    })
    const tool = createPreviewTool({
      ...dependencies(new PreviewGateway(), failingStore),
      reportAuditFailure() {
        throw new Error(`raw-reporter ${workspace} ${credentialReference}`)
      },
    })

    const result = await tool.execute({ manifestPath }, exec())

    await expect(validateCurrentPreview(store, {
      snapshotInput: await currentSnapshotInput(),
      credentialValue,
      now: new Date('2026-08-25T00:05:00.000Z'),
    })).resolves.toMatchObject({ receipt: { id: result.previewReceiptId } })
  })

  it('serializes concurrent previews and leaves one valid current pointer', async () => {
    const firstGateway = new PreviewGateway()
    const secondGateway = new PreviewGateway()
    secondGateway.html = '<article>second</article>'
    const firstTool = createPreviewTool(dependencies(firstGateway))
    const secondTool = createPreviewTool({ ...dependencies(secondGateway), layoutBaseUrl: 'https://second.example' })
    const [first, second] = await Promise.all([
      firstTool.execute({ manifestPath }, exec()),
      secondTool.execute({ manifestPath }, exec()),
    ])
    expect(first.previewReceiptId).not.toBe(second.previewReceiptId)
    const pointer = JSON.parse(decoder.decode(await store.read(`revisions/${revisionId}/previews/current.json`))) as { receiptId: string }
    expect([first.previewReceiptId, second.previewReceiptId]).toContain(pointer.receiptId)
    const winnerLayout = pointer.receiptId === first.previewReceiptId ? 'https://www.md2wechat.cn' : 'https://second.example'
    await expect(validateCurrentPreview(store, {
      snapshotInput: {
        revisionId, articlePath, articleBytes: await store.read(articlePath),
        localImages: [{ path: imagePath, bytes: await store.read(imagePath) }],
        layoutBaseUrl: winnerLayout, previewSettings: { mode: 'api', theme: 'default', fontSize: 'medium', backgroundType: 'none', output: 'standalone-html' },
        credentialReference, credentialValue, pluginVersion: '1.0.0', cliVersion: '3.3.0',
      },
      credentialValue,
      now: new Date('2026-08-25T00:05:00.000Z'),
    })).resolves.toMatchObject({ receipt: { id: pointer.receiptId } })
  })

  it('uses pure replay-safe cards without live reads or secrets', () => {
    const tool = createPreviewTool(dependencies(new PreviewGateway()))
    const args = { manifestPath }
    const first = tool.presentCall?.(args)
    expect(tool.presentCall?.(args)).toEqual(first)
    expect(first).toMatchObject({ card: 'generic', title: 'Preview md2wechat article', kind: 'edit' })
    expect(tool.presentResult?.(args, { content: [], isError: false })).toEqual({ card: 'generic', title: 'Article preview ready' })
    expect(JSON.stringify([first, tool.presentResult?.(args, { content: [], isError: false })])).not.toContain(credentialValue)
  })
})
