import { resolve } from 'node:path'
import { Context } from '../../../../web/deepseek-harness/vendor/cordis/src/index.ts'
import ToolRuntime from '../../../../web/deepseek-harness/packages/core/tools/src/index.ts'
import SystemPrompt from '../../../../web/deepseek-harness/packages/core/system-prompt/src/index.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const captured = vi.hoisted(() => ({
  doctor: [] as unknown[],
  start: [] as unknown[],
  improve: [] as unknown[],
  plan: [] as unknown[],
  preview: [] as unknown[],
  export: [] as unknown[],
  draft: [] as unknown[],
  generate: [] as unknown[],
}))

vi.mock('../../src/tools/doctor.ts', async importOriginal => wrapFactory(await importOriginal(), 'createDoctorTool', captured.doctor))
vi.mock('../../src/tools/start-article.ts', async importOriginal => wrapFactory(await importOriginal(), 'createStartArticleTool', captured.start))
vi.mock('../../src/tools/improve-article.ts', async importOriginal => wrapFactory(await importOriginal(), 'createImproveArticleTool', captured.improve))
vi.mock('../../src/tools/plan-images.ts', async importOriginal => wrapFactory(await importOriginal(), 'createPlanImagesTool', captured.plan))
vi.mock('../../src/tools/preview.ts', async importOriginal => wrapFactory(await importOriginal(), 'createPreviewTool', captured.preview))
vi.mock('../../src/tools/export.ts', async importOriginal => wrapFactory(await importOriginal(), 'createExportTool', captured.export))
vi.mock('../../src/tools/create-draft.ts', async importOriginal => wrapFactory(await importOriginal(), 'createDraftTool', captured.draft))
vi.mock('../../src/tools/generate-images.ts', async importOriginal => wrapFactory(await importOriginal(), 'createGenerateImagesTool', captured.generate))

import * as plugin from '../../src/index.ts'

type FactoryModule = Record<string, unknown>

function wrapFactory(module: FactoryModule, name: string, calls: unknown[]): FactoryModule {
  const factory = module[name]
  if (typeof factory !== 'function') throw new TypeError(`missing factory ${name}`)
  return {
    ...module,
    [name](dependencies: unknown) {
      calls.push(dependencies)
      return factory(dependencies)
    },
  }
}

function subprocess() {
  const read = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  return {
    resolveExecutable: async (path: string) => path,
    spawn(spec: { argv: readonly string[] }) {
      const argv = spec.argv.slice(1)
      const commands = [
        'inspect', 'advise', 'preview', 'config', 'write', 'humanize', 'title',
        'upload_image', 'download_and_upload', 'generate_image', 'generate_cover',
        'generate_infographic', 'create_draft', 'providers', 'capabilities', 'version',
      ]
      const data = argv[0] === 'version' ? { version: '3.3.0' } : { commands }
      const text = JSON.stringify({ success: true, code: 'OK', message: 'completed', schema_version: 'v1', status: 'completed', retryable: false, data })
      return { done: Promise.resolve({ exitCode: 0, signal: null }), waitForExit: async () => {}, collected: { stdout: read(text), stderr: read('') } }
    },
  }
}

const disposers: Array<() => Promise<void>> = []

beforeEach(() => {
  for (const values of Object.values(captured)) values.length = 0
})

afterEach(async () => {
  await Promise.all(disposers.splice(0).reverse().map(dispose => dispose()))
})

describe('plugin factory composition', () => {
  it('passes one shared gateway, artifact store, and state stores with one resolved configuration', async () => {
    const ctx = new Context()
    const prompt = await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
    const tools = await ctx.plugin(ToolRuntime, { mode: 'native' })
    disposers.push(() => tools.dispose(), () => prompt.dispose())
    ctx.provide('subprocess', subprocess() as never)
    ctx.provide('fs', {} as never)
    ctx.provide('approval', { request: async () => 'rejected' } as never)
    ctx.provide('credentials', { resolve: async () => undefined } as never)
    ctx.provide('jobs', { start() { throw new Error('not used') }, get() { return undefined } } as never)

    const stateDir = resolve('/var/lib/dsh-md2wechat-composition-test')
    const fiber = await ctx.plugin(plugin, {
      binaryPath: resolve('/opt/md2wechat'),
      stateDir,
      artifactsDir: '.plugin-artifacts',
      layoutBaseUrl: 'https://layout.example.test',
      previewTheme: 'classic',
      previewFontSize: 'large',
      previewBackgroundType: 'grid',
      imageJobTimeoutMs: 123_456,
      imageMaxBytes: 7_654_321,
      imageMaxRedirects: 2,
      imageAcquisitionTimeoutMs: 45_678,
      credentialRefs: { MD2WECHAT_API_KEY: 'MD2_KEY' },
      safeReadRetries: 0,
    })
    disposers.push(() => fiber.dispose())

    const [doctor, start, improve, plan, preview, exported, draft, generate] = [
      captured.doctor[0], captured.start[0], captured.improve[0], captured.plan[0],
      captured.preview[0], captured.export[0], captured.draft[0], captured.generate[0],
    ] as Array<Record<string, unknown>>

    expect(captured.doctor).toHaveLength(1)
    expect(captured.start).toHaveLength(1)
    expect(captured.improve).toHaveLength(1)
    expect(captured.plan).toHaveLength(1)
    expect(captured.preview).toHaveLength(1)
    expect(captured.export).toHaveLength(1)
    expect(captured.draft).toHaveLength(1)
    expect(captured.generate).toHaveLength(1)

    expect(improve.gateway).toBe(doctor.gateway)
    expect(plan.gateway).toBe(doctor.gateway)
    expect(preview.gateway).toBe(doctor.gateway)
    expect(draft.gateway).toBe(doctor.gateway)
    expect(generate.gateway).toBe(doctor.gateway)
    expect([improve.store, plan.store, preview.store, exported.store, draft.store, generate.store])
      .toEqual(Array(6).fill(start.store))
    expect(draft.imagePlanState).toBe(plan.state)
    expect(generate.state).toBe(plan.state)
    expect((plan.state as { stateDir: string }).stateDir).toBe(stateDir)
    expect((draft.state as { stateDir: string }).stateDir).toBe(stateDir)
    expect((start.store as { rootRelative: string }).rootRelative).toBe('.plugin-artifacts')
    expect(start.workspace).toBe(process.cwd())
    expect(preview.layoutBaseUrl).toBe('https://layout.example.test')
    expect(exported.previewTheme).toBe('classic')
    expect(draft.previewFontSize).toBe('large')
    expect(generate.imageJobTimeoutMs).toBe(123_456)
    expect(generate.imageMaxBytes).toBe(7_654_321)
    expect(generate.imageMaxRedirects).toBe(2)
    expect(generate.imageAcquisitionTimeoutMs).toBe(45_678)
    expect(generate.credentialRefs).toBe(preview.credentialRefs)
  })
})
