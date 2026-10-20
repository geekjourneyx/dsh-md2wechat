import { describe, expect, it, vi } from 'vitest'
import { createPlanImagesOperation } from '../../src/tools/plan-images.ts'
import { createGenerateImagesOperation, type GenerateImagesToolDependencies } from '../../src/tools/generate-images.ts'

function generationDependencies(): GenerateImagesToolDependencies {
  return {
    gateway: { run: vi.fn() }, store: { read: vi.fn(), createExclusive: vi.fn() },
    state: { initialize: vi.fn(), verify: vi.fn() }, credentialRefs: {},
    credentials: { resolve: vi.fn() }, approval: { request: vi.fn() },
    jobs: { start: vi.fn(), get: vi.fn() }, imageJobTimeoutMs: 1000,
    imageMaxBytes: 1024, imageMaxRedirects: 0, imageAcquisitionTimeoutMs: 1000,
    reportAuditFailure: vi.fn(),
  } as unknown as GenerateImagesToolDependencies
}

const context = () => ({ agent: undefined, callId: 'creator-image-call' as never, signal: new AbortController().signal })

describe('shared image operations', () => {
  it('rejects unknown planning arguments before storage or CLI calls using signal-only context', async () => {
    const state = { initialize: vi.fn() }
    const gateway = { run: vi.fn() }
    const operation = createPlanImagesOperation({ state, gateway } as never)
    await expect(operation({ manifestPath: 'x', images: [], extra: true } as never, { signal: context().signal }))
      .rejects.toThrow('unknown plan-images argument extra')
    expect(state.initialize).not.toHaveBeenCalled()
    expect(gateway.run).not.toHaveBeenCalled()
  })

  it('retains generation factory dependency validation', () => {
    expect(() => createGenerateImagesOperation({ ...generationDependencies(), imageMaxBytes: 0 }))
      .toThrow('maximum image bytes')
    expect(() => createGenerateImagesOperation({ ...generationDependencies(), reportAuditFailure: undefined } as never))
      .toThrow('image audit failure reporter')
  })

  it('rejects unknown generation arguments before approval, credentials, jobs or CLI calls', async () => {
    const deps = generationDependencies()
    await expect(createGenerateImagesOperation(deps)({ manifestPath: 'x', planPaths: [], extra: true } as never, context()))
      .rejects.toThrow('unknown md2wechat_generate_images argument')
    expect(deps.approval.request).not.toHaveBeenCalled()
    expect(deps.credentials.resolve).not.toHaveBeenCalled()
    expect(deps.jobs.start).not.toHaveBeenCalled()
    expect(deps.gateway.run).not.toHaveBeenCalled()
  })

  it('honors cancellation before generation authority or provider work', async () => {
    const deps = generationDependencies()
    const abort = new AbortController()
    abort.abort()
    await expect(createGenerateImagesOperation(deps)({ manifestPath: 'x', planPaths: [] }, { ...context(), signal: abort.signal }))
      .rejects.toThrow('fallback image generation was cancelled')
    expect(deps.state.initialize).not.toHaveBeenCalled()
    expect(deps.approval.request).not.toHaveBeenCalled()
    expect(deps.jobs.start).not.toHaveBeenCalled()
  })
})
