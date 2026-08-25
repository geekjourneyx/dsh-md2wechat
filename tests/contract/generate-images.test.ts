import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { JobHooks, JobId, JobStart } from '@deepseek-ai/dsh-jobs'
import type { CliEnvelope } from '../../src/cli/protocol.ts'
import type { CliGateway, CliRunOptions } from '../../src/cli/gateway.ts'
import { createGenerateImagesTool } from '../../src/tools/generate-images.ts'
import { ArtifactStore } from '../../src/workspace/artifact-store.ts'
import { canonicalImagePlanId, encodeCanonical } from '../../src/workspace/images.ts'
import { computeArticleRevision } from '../../src/workspace/revision.ts'
import type { ArticleManifest } from '../../src/workspace/revision.ts'

interface TestTarget { targetKey: string; displayPath: string }
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const now = new Date('2026-08-25T04:00:00.000Z')
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0])

function createTestFileSystem(cwd: string) {
  return {
    async resolve(path: string): Promise<TestTarget> {
      const displayPath = resolve(cwd, path); let ancestor = displayPath; const missing: string[] = []
      while (true) {
        try { return { displayPath, targetKey: join(await realpath(ancestor), ...missing) } } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
          missing.unshift(basename(ancestor)); const parent = dirname(ancestor)
          if (parent === ancestor) return { displayPath, targetKey: displayPath }; ancestor = parent
        }
      }
    },
    processPath(target: TestTarget): string { return target.targetKey },
    contains(parent: TestTarget, child: TestTarget): boolean { const candidate = relative(parent.targetKey, child.targetKey); return candidate === '' || (!candidate.startsWith('..') && !isAbsolute(candidate)) },
    async stat(target: TestTarget) {
      try { const info = await stat(target.targetKey); return { version: `${info.mtimeMs}:${info.size}`, type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other', size: info.size } }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error }
    },
    async readBytes(target: TestTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
      signal?.throwIfAborted()
      try { const bytes = await readFile(target.targetKey); if (bytes.byteLength > maxBytes) throw new Error('too large'); return bytes }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { const missing = new Error('missing') as Error & { code: string }; missing.code = 'FS_NOT_FOUND'; throw missing } throw error }
    },
  }
}

class Gateway implements CliGateway {
  readonly calls: Array<{ argv: readonly string[]; options?: CliRunOptions }> = []
  mutate?: (response: CliEnvelope) => CliEnvelope
  resolve(): Promise<string> { return Promise.resolve('/fixture/md2wechat') }
  async run(argv: readonly string[], options?: CliRunOptions): Promise<CliEnvelope> {
    if (options?.beforeSpawn !== undefined) await options.beforeSpawn(options.signal ?? new AbortController().signal)
    this.calls.push({ argv: [...argv], options })
    const command = argv[0]!
    const prompt = command === 'generate_image' && argv[1] !== '--preset' ? argv[1]! : command === 'generate_cover' ? 'Prepared cover prompt' : 'Prepared preset prompt'
    const response: CliEnvelope = { success: true, code: 'OK', message: 'Success', schema_version: 'v1', status: 'completed', retryable: false,
      data: { prompt, original_url: 'https://images.example/result.png', media_id: 'media-safe', wechat_url: 'https://mmbiz.qpic.cn/result.png', width: 0, height: 0 } }
    return this.mutate?.(response) ?? response
  }
}

describe('md2wechat_generate_images', () => {
  let temporary: string; let workspace: string; let store: ArtifactStore; let manifestPath: string; let revisionId: string; let planPath: string
  let approval: 'allowed-once' | 'rejected'; let approvals: Array<Record<string, unknown>>; let resolved: string[]; let starts: JobStart[]; let hooks: JobHooks | undefined
  const agent = { id: 'session-fixture' } as never

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'dsh-md2wechat-generate-images-')); workspace = join(temporary, 'workspace'); await mkdir(workspace)
    store = new ArtifactStore(createTestFileSystem(workspace) as never, workspace, '.dsh/md2wechat')
    const article = encoder.encode('# Fixture\n'); const manifest: ArticleManifest = { schemaVersion: 1, articlePath: 'article.md', manifestPath: 'manifest.json', createdAt: now.toISOString(), title: 'Fixture' }
    const revision = computeArticleRevision(article, manifest); revisionId = revision.id; manifestPath = `revisions/${revisionId}/manifest.json`
    await store.writeAtomic(`revisions/${revisionId}/article.md`, article); await store.writeAtomic(manifestPath, encoder.encode(`${JSON.stringify(manifest)}\n`)); planPath = await installPlan()
    approval = 'allowed-once'; approvals = []; resolved = []; starts = []; hooks = undefined
  })
  afterEach(async () => { await import('node:fs/promises').then(fs => fs.rm(temporary, { recursive: true, force: true })) })

  async function installPlan(): Promise<string> {
    const item = { original: { id: 'hero', kind: 'image', prompt: 'Hero raw', targetPath: 'images/hero.png' }, targetArtifactPath: `revisions/${revisionId}/images/hero.png`,
      cliPlan: { mode: 'plan', command: 'generate_image', execution_owner: 'host_agent', side_effects: false, requires_provider: false, requires_image_api_key: false,
        prompt: 'Hero raw', raw_prompt: 'Hero raw', preset: '', archetype: '', primary_use_case: '', compatible_use_cases: [], recommended_aspect_ratios: [], default_aspect_ratio: '',
        article: '', title: '', summary: '', keywords: '', style: '', aspect: '', size: '', model_hint: '', suggested_filename: '', alt_text: '' } }
    const items = [item]; const planId = canonicalImagePlanId(revisionId, items); const path = `revisions/${revisionId}/plans/${planId}.json`
    await store.writeAtomic(path, encodeCanonical({ schemaVersion: 1, planId, revisionId, createdAt: now.toISOString(), items })); return path
  }

  function dependencies(gateway: CliGateway) {
    return { gateway, store, credentialRefs: { IMAGE_API_KEY: 'IMAGE_API_KEY', WECHAT_APPID: 'WECHAT_APPID', WECHAT_SECRET: 'WECHAT_SECRET' },
      credentials: { resolve(ref: string) { resolved.push(ref); return Promise.resolve({ value: `secret-${ref}`, source: 'test' }) } },
      approval: { request(request: Record<string, unknown>) { approvals.push(request); return Promise.resolve(approval) } },
      jobs: { start(spec: JobStart) { starts.push(spec); hooks = spec.run(); return 'md2wechat-image-1' as JobId }, get() { throw new Error('not live') } },
      imageJobTimeoutMs: 5000, imageMaxBytes: 1024, imageMaxRedirects: 2, imageAcquisitionTimeoutMs: 1000,
      acquire: async () => ({ bytes: png, mimeType: 'image/png' as const, extension: '.png' as const, finalUrl: 'https://images.example/result.png' }),
      now: () => new Date(now), claimNonce: () => 'claim-nonce' }
  }
  function exec(signal = new AbortController().signal) { return { signal, callId: 'image-call' as never, name: 'md2wechat_generate_images', arguments: {}, rootCallId: 'image-call' as never, token: Symbol('image') as never, agent, deferContext() {}, concludeTurn() {} } }

  it('asks once, resolves exactly three credentials, returns an owner-scoped job and publishes a verified result', async () => {
    const gateway = new Gateway(); const tool = createGenerateImagesTool(dependencies(gateway)); const result = await tool.execute({ manifestPath, planPaths: [planPath] }, exec())
    expect(result).toMatchObject({ kind: 'background', jobId: 'md2wechat-image-1', planIds: [basename(planPath, '.json')] })
    expect(gateway.calls).toHaveLength(0)
    expect(approvals).toHaveLength(1); expect(String(approvals[0]!.reason)).toContain('upload each generated image to WeChat material storage')
    expect(resolved).toEqual(['IMAGE_API_KEY', 'WECHAT_APPID', 'WECHAT_SECRET']); expect(starts[0]).toMatchObject({ kind: 'md2wechat-image', owner: agent, outputLimitBytes: 16384 })
    const outcome = await hooks!.done; expect(outcome).toMatchObject({ status: 'completed', detail: 'all images complete' }); expect(JSON.stringify(outcome)).not.toContain('secret-'); expect(JSON.stringify(outcome)).not.toContain('images.example')
    expect(gateway.calls[0]!.argv).toEqual(['generate_image', 'Hero raw', '--json']); expect(gateway.calls[0]!.options).toMatchObject({ env: { IMAGE_API_KEY: 'secret-IMAGE_API_KEY', WECHAT_APPID: 'secret-WECHAT_APPID', WECHAT_SECRET: 'secret-WECHAT_SECRET' }, secrets: ['secret-IMAGE_API_KEY', 'secret-WECHAT_APPID', 'secret-WECHAT_SECRET'] })
    const planId = basename(planPath, '.json'); const resultPath = `revisions/${revisionId}/image-results/${planId}/hero.json`; const persisted = JSON.parse(decoder.decode(await store.read(resultPath))) as Record<string, unknown>
    expect(persisted).toMatchObject({ planId, itemId: 'hero', targetPath: `revisions/${revisionId}/images/hero.png`, remoteUrl: 'https://images.example/result.png', mediaId: 'media-safe' }); expect(persisted.sha256).toBe(createHash('sha256').update(png).digest('hex')); expect(Array.from(await store.read(`revisions/${revisionId}/images/hero.png`))).toEqual(Array.from(png))
    await expect(store.read(`revisions/${revisionId}/image-claims/${planId}/hero.json`)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    const jobDirectory = dirname(store.resolve(`revisions/${revisionId}/image-jobs/placeholder`)); await expect(import('node:fs/promises').then(fs => fs.readdir(jobDirectory))).resolves.toEqual([])
    approvals.length = 0; resolved.length = 0; starts.length = 0; const complete = await tool.execute({ manifestPath, planPaths: [planPath] }, exec()); expect(complete).toMatchObject({ kind: 'completed', resultPaths: [resultPath] }); expect(approvals).toHaveLength(0); expect(resolved).toHaveLength(0); expect(starts).toHaveLength(0)
  })

  it('never resolves credentials or starts work when denied, empty, or duplicated', async () => {
    const tool = createGenerateImagesTool(dependencies(new Gateway())); approval = 'rejected'
    await expect(tool.execute({ manifestPath, planPaths: [planPath] }, exec())).rejects.toThrow('not approved'); expect(resolved).toHaveLength(0); expect(starts).toHaveLength(0)
    approvals.length = 0; await expect(tool.execute({ manifestPath, planPaths: [] }, exec())).rejects.toThrow('at least one'); await expect(tool.execute({ manifestPath, planPaths: [planPath, planPath] }, exec())).rejects.toThrow('duplicate'); expect(approvals).toHaveLength(0)
  })

  it('transfers cancellation to the job hook and keeps done non-rejecting', async () => {
    const deps = dependencies(new Gateway()); deps.acquire = async (_url, options) => { await new Promise((_, reject) => options.signal?.addEventListener('abort', () => reject(new Error('provider secret raw failure')), { once: true })); return { bytes: png, mimeType: 'image/png', extension: '.png', finalUrl: 'https://images.example/result.png' } }
    const tool = createGenerateImagesTool(deps); await tool.execute({ manifestPath, planPaths: [planPath] }, exec()); hooks!.cancel('kill'); const outcome = await hooks!.done
    expect(outcome.status).toBe('killed'); expect(JSON.stringify(outcome)).not.toContain('provider secret')
  })

  it('contains strict provider-response failures and cleans claims and snapshots', async () => {
    const gateway = new Gateway(); gateway.mutate = response => ({ ...response, data: { ...response.data, api_key: 'secret-injected' } })
    const tool = createGenerateImagesTool(dependencies(gateway)); await tool.execute({ manifestPath, planPaths: [planPath] }, exec()); const outcome = await hooks!.done
    expect(outcome.status).toBe('failed'); expect(JSON.stringify(outcome)).not.toContain('secret-injected')
    const planId = basename(planPath, '.json'); await expect(store.read(`revisions/${revisionId}/image-results/${planId}/hero.json`)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' }); await expect(store.read(`revisions/${revisionId}/image-claims/${planId}/hero.json`)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('sanitizes job registration failure and leaves no worker running', async () => {
    const deps = dependencies(new Gateway()); deps.jobs.start = () => { throw new Error('/private/secret/provider') }
    const tool = createGenerateImagesTool(deps)
    await expect(tool.execute({ manifestPath, planPaths: [planPath] }, exec())).rejects.toThrow('could not be started')
    expect(resolved).toEqual(['IMAGE_API_KEY', 'WECHAT_APPID', 'WECHAT_SECRET'])
    await new Promise(resolve => setImmediate(resolve))
    expect(starts).toHaveLength(0)
  })
})
