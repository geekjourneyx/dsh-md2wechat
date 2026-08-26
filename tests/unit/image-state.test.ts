import { describe, expect, it, vi } from 'vitest'
import { createPrivateKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import {
  acquireImageClaim,
  acquireRemoteImage,
  canonicalImagePlanId,
  encodeCanonical,
  isPublicNetworkAddress,
  loadImagePlan,
  nodePinnedHttpsRequest,
  releaseImageClaim,
  validateRemoteImageUrl,
} from '../../src/workspace/images.ts'

describe('image state', () => {
  it('recomputes one stable plan id from revision and projected items', () => {
    const revisionId = 'a'.repeat(64)
    const items = [{ original: { id: 'hero', kind: 'image', prompt: 'Hero', targetPath: 'images/hero.png' }, targetArtifactPath: `revisions/${revisionId}/images/hero.png`, cliPlan: { prompt: 'Hero' } }]
    expect(canonicalImagePlanId(revisionId, items)).toMatch(/^[a-f0-9]{64}$/u)
    expect(canonicalImagePlanId(revisionId, items)).toBe(canonicalImagePlanId(revisionId, structuredClone(items)))
  })

  it.each([
    'http://example.com/image.png',
    'file:///tmp/image.png',
    'https://user:secret@example.com/image.png',
    'https://example.com/image.png#fragment',
  ])('rejects unsafe remote URL %s', (url) => {
    expect(() => validateRemoteImageUrl(url)).toThrow('image URL')
  })

  it.each([
    '127.0.0.1', '0.0.0.0', '10.0.0.1', '172.16.0.1', '192.168.0.1',
    '169.254.1.1', '100.64.0.1', '224.0.0.1', '::1', '::', 'fc00::1',
    'fe80::1', 'ff00::1', '::ffff:127.0.0.1', '::ffff:192.168.1.1', '::ffff:8.8.8.8', '2001:db8::1',
    '192.31.196.1', '192.52.193.1', '192.88.99.1', '192.175.48.1',
    '64:ff9b::c0a8:101', '64:ff9b:1::1', '2001::1', '2001:10::1', '2001:20::1', '2002:c0a8:101::1',
    '2620:4f:8000::1', '3fff::1', '5f00::1',
  ])('rejects non-public address %s', (address) => {
    expect(isPublicNetworkAddress(address)).toBe(false)
  })

  it('pins validated DNS and accepts a small PNG without using ambient resolution', async () => {
    const requests: Array<Record<string, unknown>> = []
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
    const result = await acquireRemoteImage('https://images.example/picture.bin', {
      maxBytes: 32,
      maxRedirects: 1,
      timeoutMs: 1000,
      resolve: async () => ['93.184.216.34'],
      request: async options => {
        requests.push(options)
        return { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(png.byteLength) }, body: png }
      },
    })
    expect(requests).toEqual([expect.objectContaining({ hostname: 'images.example', address: '93.184.216.34', servername: 'images.example' })])
    expect(result).toMatchObject({ mimeType: 'image/png', extension: '.png', bytes: png })
  })

  it('validates every redirect and enforces declared and streamed size limits', async () => {
    const resolveCalls: string[] = []
    await expect(acquireRemoteImage('https://public.example/a', {
      maxBytes: 8,
      maxRedirects: 1,
      timeoutMs: 1000,
      resolve: async hostname => {
        resolveCalls.push(hostname)
        return hostname === 'public.example' ? ['93.184.216.34'] : ['127.0.0.1']
      },
      request: async ({ hostname }) => hostname === 'public.example'
        ? { status: 302, headers: { location: 'https://private.example/b' }, body: new Uint8Array() }
        : { status: 200, headers: { 'content-type': 'image/png', 'content-length': '9' }, body: new Uint8Array(9) },
    })).rejects.toThrow('public network')
    expect(resolveCalls).toEqual(['public.example', 'private.example'])
  })

  it('performs no DNS or transport work when the parent is already aborted', async () => {
    const parent = new AbortController(); parent.abort(new Error('already cancelled'))
    let resolves = 0; let requests = 0
    await expect(acquireRemoteImage('https://images.example/file.png', {
      maxBytes: 64, maxRedirects: 0, timeoutMs: 1000, signal: parent.signal,
      resolve: async () => { resolves += 1; return ['93.184.216.34'] },
      request: async () => { requests += 1; return { status: 500, headers: {}, body: new Uint8Array() } },
    })).rejects.toThrow()
    expect({ resolves, requests }).toEqual({ resolves: 0, requests: 0 })
  })

  it('times out unresolved DNS before transport and safely consumes late resolver outcomes', async () => {
    vi.useFakeTimers()
    try {
      for (const lateOutcome of ['resolve', 'reject'] as const) {
        let state: 'pending' | 'resolved' | 'rejected' = 'pending'
        let failure: unknown
        let requests = 0
        const acquisition = acquireRemoteImage('https://images.example/file.png', {
          maxBytes: 64, maxRedirects: 0, timeoutMs: 5,
          resolve: async () => new Promise<readonly string[]>((resolve, reject) => setTimeout(() => {
            if (lateOutcome === 'resolve') resolve(['93.184.216.34'])
            else reject(new Error('late resolver failure'))
          }, 40)),
          request: async () => { requests += 1; return { status: 500, headers: {}, body: new Uint8Array() } },
        })
        void acquisition.then(
          () => { state = 'resolved' },
          error => { state = 'rejected'; failure = error },
        )

        await vi.advanceTimersByTimeAsync(5)
        expect(state).toBe('rejected')
        expect(String(failure)).toContain('timed out')
        expect(requests).toBe(0)

        await vi.advanceTimersByTimeAsync(35)
        expect(requests).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
      }
    } finally {
      await vi.runAllTimersAsync()
      vi.useRealTimers()
    }
  })

  it('uses the prevalidated address with Node all:true lookup options in the production HTTPS transport', async () => {
    const [key, cert] = await Promise.all([
      readFile(new URL('../fixtures/pinned.invalid-key.pk8.b64', import.meta.url), 'utf8'),
      readFile(new URL('../fixtures/pinned.invalid-cert.pem', import.meta.url), 'utf8'),
    ])
    const privateKey = createPrivateKey({ key: Buffer.from(key.trim(), 'base64'), format: 'der', type: 'pkcs8' })
      .export({ format: 'pem', type: 'pkcs8' })
    let receivedHost = ''
    const server = createServer({ key: privateKey, cert }, (request, response) => {
      receivedHost = request.headers.host ?? ''
      response.writeHead(200, { 'content-length': '2', 'content-type': 'text/plain' })
      response.end('ok')
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('local server address unavailable')
    try {
      const response = await nodePinnedHttpsRequest({
        url: `https://pinned.invalid:${address.port}/`, hostname: 'pinned.invalid', port: address.port,
        path: '/', address: '127.0.0.1', servername: 'pinned.invalid', signal: new AbortController().signal, maxBytes: 64,
        ca: cert,
      })
      expect(response).toMatchObject({ status: 200, body: new TextEncoder().encode('ok') })
      expect(receivedHost).toBe(`pinned.invalid:${address.port}`)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('strictly loads the canonical Task 5 plan and rejects unknown fields or changed IDs', async () => {
    const revisionId = 'a'.repeat(64)
    const item = {
      original: { id: 'hero', kind: 'image', prompt: 'raw', targetPath: 'images/hero.png' },
      targetArtifactPath: `revisions/${revisionId}/images/hero.png`,
      cliPlan: {
        mode: 'plan', command: 'generate_image', execution_owner: 'host_agent', side_effects: false,
        requires_provider: false, requires_image_api_key: false, prompt: 'raw', raw_prompt: 'raw', preset: '',
        archetype: '', primary_use_case: '', compatible_use_cases: [], recommended_aspect_ratios: [],
        default_aspect_ratio: '', article: '', title: '', summary: '', keywords: '', style: '', aspect: '', size: '',
        model_hint: '', suggested_filename: '', alt_text: '',
      },
    }
    const items = [item]
    const planId = canonicalImagePlanId(revisionId, items)
    const value = { schemaVersion: 1, planId, revisionId, createdAt: '2026-08-25T00:00:00.000Z', items }
    const store = { readBounded: async () => encodeCanonical(value) }
    const plan = await loadImagePlan(store as never, `revisions/${revisionId}/plans/${planId}.json`, revisionId, `revisions/${revisionId}/article.md`)
    expect(plan.items[0]).toMatchObject({ id: 'hero', prompt: 'raw', targetPath: `revisions/${revisionId}/images/hero.png` })
    const unknown = { ...value, debug: 'secret' }
    await expect(loadImagePlan({ readBounded: async () => encodeCanonical(unknown) } as never, plan.path, revisionId, `revisions/${revisionId}/article.md`)).rejects.toThrow('unknown')
  })

  it('accepts real 3.3.0 cover defaults and uses resolved preset/aspect semantics', async () => {
    const revisionId = 'c'.repeat(64)
    const articlePath = `revisions/${revisionId}/article.md`
    const item = {
      original: { id: 'cover', kind: 'cover', prompt: 'direction only', targetPath: 'images/cover.png' },
      targetArtifactPath: `revisions/${revisionId}/images/cover.png`,
      cliPlan: {
        mode: 'plan', command: 'generate_cover', execution_owner: 'host_agent', side_effects: false,
        requires_provider: false, requires_image_api_key: false, prompt: 'Rendered cover prompt', raw_prompt: '', preset: 'cover-default',
        archetype: 'cover', primary_use_case: 'cover', compatible_use_cases: ['cover'], recommended_aspect_ratios: ['16:9'],
        default_aspect_ratio: '16:9', article: articlePath, title: 'Fixture', summary: '', keywords: '', style: 'editorial', aspect: '16:9', size: '', model_hint: '', suggested_filename: 'fixture.png', alt_text: 'Fixture',
      },
    }
    const items = [item]; const planId = canonicalImagePlanId(revisionId, items)
    const plan = await loadImagePlan({ readBounded: async () => encodeCanonical({ schemaVersion: 1, planId, revisionId, createdAt: '2026-08-25T00:00:00.000Z', items }) } as never, `revisions/${revisionId}/plans/${planId}.json`, revisionId, articlePath)
    expect(plan.items[0]).toMatchObject({ preset: 'cover-default', aspect: '16:9', prompt: 'Rendered cover prompt' })
  })

  it.each([
    { id: 'hero', kind: 'image' as const, originalPreset: 'cover-hero', resolvedPreset: 'cover-hero', archetype: 'cover', aspect: '16:9' },
    { id: 'info', kind: 'infographic' as const, originalPreset: undefined, resolvedPreset: 'infographic-default', archetype: 'infographic', aspect: '3:4' },
    { id: 'compatible-cover', kind: 'cover' as const, originalPreset: 'infographic-comparison', resolvedPreset: 'infographic-comparison', archetype: 'infographic', aspect: '16:9', defaultAspect: '3:4', compatible: ['infographic', 'cover'], recommended: ['3:4', '16:9'] },
  ])('accepts real 3.3.0 resolved $kind preset/aspect output', async fixture => {
    const revisionId = 'e'.repeat(64); const articlePath = `revisions/${revisionId}/article.md`
    const original = { id: fixture.id, kind: fixture.kind, prompt: 'direction', targetPath: `images/${fixture.id}.png`, ...(fixture.originalPreset === undefined ? {} : { preset: fixture.originalPreset, aspect: fixture.aspect }) }
    const cliPlan = { mode: 'plan', command: fixture.kind === 'image' ? 'generate_image' : fixture.kind === 'cover' ? 'generate_cover' : 'generate_infographic', execution_owner: 'host_agent', side_effects: false, requires_provider: false, requires_image_api_key: false,
      prompt: `Rendered ${fixture.kind} prompt`, raw_prompt: '', preset: fixture.resolvedPreset, archetype: fixture.archetype, primary_use_case: fixture.archetype,
      compatible_use_cases: 'compatible' in fixture ? fixture.compatible : [fixture.archetype], recommended_aspect_ratios: 'recommended' in fixture ? fixture.recommended : [fixture.aspect], default_aspect_ratio: 'defaultAspect' in fixture ? fixture.defaultAspect : fixture.aspect,
      article: articlePath, title: 'Fixture', summary: 'Summary', keywords: '', style: 'editorial', aspect: fixture.aspect, size: '', model_hint: '', suggested_filename: `${fixture.id}.png`, alt_text: 'Fixture' }
    const items = [{ original, targetArtifactPath: `revisions/${revisionId}/images/${fixture.id}.png`, cliPlan }]; const planId = canonicalImagePlanId(revisionId, items)
    const plan = await loadImagePlan({ readBounded: async () => encodeCanonical({ schemaVersion: 1, planId, revisionId, createdAt: '2026-08-25T00:00:00.000Z', items }) } as never, `revisions/${revisionId}/plans/${planId}.json`, revisionId, articlePath)
    expect(plan.items[0]).toMatchObject({ preset: fixture.resolvedPreset, aspect: fixture.aspect, prompt: `Rendered ${fixture.kind} prompt` })
  })

  it('rejects a bounded plan containing an embedded Unix, Windows, UNC, or file process path without a raw cause', async () => {
    const revisionId = 'f'.repeat(64); const articlePath = `revisions/${revisionId}/article.md`
    for (const leaked of [
      '/Users/private/secret.md', 'argument=/Users/private/secret.md',
      'C:\\Users\\private\\secret.md', 'argument=C:\\Users\\private\\secret.md',
      '\\\\server\\share\\secret.md', 'argument=\\\\server\\share\\secret.md',
      'file:///private/secret.md',
    ]) {
      const approvedPrompt = `render ${leaked}`
      const original = { id: 'hero', kind: 'image', prompt: approvedPrompt, targetPath: 'images/hero.png' }
      const cliPlan = { mode: 'plan', command: 'generate_image', execution_owner: 'host_agent', side_effects: false, requires_provider: false, requires_image_api_key: false, prompt: approvedPrompt, raw_prompt: approvedPrompt, preset: '', archetype: '', primary_use_case: '', compatible_use_cases: ['https://example.com/valid/path'], recommended_aspect_ratios: [], default_aspect_ratio: '', article: '', title: '', summary: '', keywords: '', style: '', aspect: '', size: '', model_hint: '', suggested_filename: '', alt_text: '' }
      const items = [{ original, targetArtifactPath: `revisions/${revisionId}/images/hero.png`, cliPlan }]; const planId = canonicalImagePlanId(revisionId, items)
      const error = await loadImagePlan({ readBounded: async () => encodeCanonical({ schemaVersion: 1, planId, revisionId, createdAt: '2026-08-25T00:00:00.000Z', items }) } as never, `revisions/${revisionId}/plans/${planId}.json`, revisionId, articlePath).catch(value => value)
      expect(String(error)).toContain('path'); expect((error as Error).cause).toBeUndefined()
    }
  })

  it('rejects oversized plans and recursively embedded process paths without raw causes', async () => {
    const revisionId = 'd'.repeat(64); const articlePath = `revisions/${revisionId}/article.md`
    const original = { id: 'hero', kind: 'image', prompt: 'raw', targetPath: 'images/hero.png' }
    const cliPlan = { mode: 'plan', command: 'generate_image', execution_owner: 'host_agent', side_effects: false, requires_provider: false, requires_image_api_key: false, prompt: `leak /Users/private/secret.md ${'x'.repeat(1024 * 1024)}`, raw_prompt: 'raw', preset: '', archetype: '', primary_use_case: '', compatible_use_cases: [], recommended_aspect_ratios: [], default_aspect_ratio: '', article: '', title: '', summary: '', keywords: '', style: '', aspect: '', size: '', model_hint: '', suggested_filename: '', alt_text: '' }
    const items = [{ original, targetArtifactPath: `revisions/${revisionId}/images/hero.png`, cliPlan }]; const planId = canonicalImagePlanId(revisionId, items)
    const bytes = encodeCanonical({ schemaVersion: 1, planId, revisionId, createdAt: '2026-08-25T00:00:00.000Z', items })
    const error = await loadImagePlan({ readBounded: async () => bytes } as never, `revisions/${revisionId}/plans/${planId}.json`, revisionId, articlePath).catch(value => value)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toMatch(/size|path|limit/iu)
    expect((error as Error).cause).toBeUndefined()
  })

  it('creates one exclusive claim across stores and releases only matching ownership', async () => {
    const files = new Map<string, Uint8Array>()
    const fakeStore = () => ({
      canonicalIdentity: async (path: string) => path,
      async createExclusive(path: string, bytes: Uint8Array) {
        if (files.has(path)) { const error = new Error('exists') as Error & { code: string }; error.code = 'ARTIFACT_EXISTS'; throw error }
        files.set(path, bytes)
        return { created: true }
      },
      async read(path: string) { const value = files.get(path); if (value === undefined) { const error = new Error('missing') as Error & { code: string }; error.code = 'FS_NOT_FOUND'; throw error }; return value },
      async removeIfMatching(path: string, expected: string) {
        const value = files.get(path)
        if (value !== undefined && (await import('node:crypto')).createHash('sha256').update(value).digest('hex') === expected) files.delete(path)
      },
    })
    const plan = { revisionId: 'a'.repeat(64), planId: 'b'.repeat(64) } as never
    const item = { id: 'hero', targetPath: `revisions/${'a'.repeat(64)}/images/hero.png` } as never
    const input = { jobId: 'md2wechat-image-1', sessionId: 'session', now: new Date('2026-08-25T00:00:00.000Z'), staleAfterMs: 1000, ownerIsLive: async () => true, nonce: 'one' }
    const [first, second] = await Promise.allSettled([
      acquireImageClaim(fakeStore() as never, plan, item, input),
      acquireImageClaim(fakeStore() as never, plan, item, { ...input, jobId: 'md2wechat-image-2', nonce: 'two' }),
    ])
    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected'])
    const ownership = first.status === 'fulfilled' ? first.value : (second as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireImageClaim>>>).value
    await releaseImageClaim(fakeStore() as never, { ...ownership, sha256: '0'.repeat(64) })
    expect(files.size).toBe(1)
    await releaseImageClaim(fakeStore() as never, ownership)
    expect(files.size).toBe(0)
  })

  it('reaps a dead owner after exact revalidation and an old nonce cannot release the replacement', async () => {
    const files = new Map<string, Uint8Array>()
    const store = {
      canonicalIdentity: async (path: string) => path,
      async createExclusive(path: string, bytes: Uint8Array) { if (files.has(path)) { const error = new Error('exists') as Error & { code: string }; error.code = 'ARTIFACT_EXISTS'; throw error }; files.set(path, bytes); return { created: true } },
      async read(path: string) { return files.get(path)! },
      async removeIfMatching(path: string, expected: string) { const bytes = files.get(path); if (bytes !== undefined && (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex') === expected) files.delete(path) },
    }
    const plan = { revisionId: 'a'.repeat(64), planId: 'b'.repeat(64) } as never
    const item = { id: 'hero', targetPath: `revisions/${'a'.repeat(64)}/images/hero.png` } as never
    const common = { sessionId: 'session', now: new Date('2026-08-25T00:00:00.000Z'), staleAfterMs: 1000 }
    const old = await acquireImageClaim(store as never, plan, item, { ...common, jobId: 'md2wechat-image-1', ownerIsLive: async () => false, nonce: 'old' })
    files.set(old.path, new TextEncoder().encode('{corrupt claim'))
    const replacement = await acquireImageClaim(store as never, plan, item, { ...common, jobId: 'md2wechat-image-2', ownerIsLive: async () => false, nonce: 'new' })
    await releaseImageClaim(store as never, old)
    expect(files.size).toBe(1)
    await releaseImageClaim(store as never, replacement)
    expect(files.size).toBe(0)
  })

  it('excludes the same canonical target across different plans', async () => {
    const files = new Map<string, Uint8Array>()
    const store = {
      canonicalIdentity: async () => '/canonical/revisions/images/shared.png',
      async createExclusive(path: string, bytes: Uint8Array) { if (files.has(path)) { const error = new Error('exists') as Error & { code: string }; error.code = 'ARTIFACT_EXISTS'; throw error }; files.set(path, bytes); return { created: true } },
      async read(path: string) { return files.get(path)! },
      async removeIfMatching() {},
    }
    const item = { id: 'hero', targetPath: `revisions/${'a'.repeat(64)}/images/shared.png` } as never
    const first = await acquireImageClaim(store as never, { revisionId: 'a'.repeat(64), planId: '1'.repeat(64) } as never, item, { jobId: 'md2wechat-image-1', sessionId: 's', now: new Date(), staleAfterMs: 1000, ownerIsLive: async () => true, nonce: 'first' })
    await expect(acquireImageClaim(store as never, { revisionId: 'a'.repeat(64), planId: '2'.repeat(64) } as never, item, { jobId: 'md2wechat-image-2', sessionId: 's', now: new Date(), staleAfterMs: 1000, ownerIsLive: async () => true, nonce: 'second' })).rejects.toThrow('claimed')
    expect(first.path).toContain('image-claims')
  })

  it.each([
    ['image/jpeg', Uint8Array.from([0xff, 0xd8, 0xff, 0]), '.jpg'],
    ['image/gif', new TextEncoder().encode('GIF89a0'), '.gif'],
    ['image/webp', new TextEncoder().encode('RIFF0000WEBP'), '.webp'],
  ] as const)('derives %s extension from MIME and magic bytes', async (mime, body, extension) => {
    const result = await acquireRemoteImage('https://images.example/file', {
      maxBytes: 64, maxRedirects: 0, timeoutMs: 1000,
      resolve: async () => ['93.184.216.34'],
      request: async () => ({ status: 200, headers: { 'content-type': mime, 'content-length': String(body.byteLength) }, body }),
    })
    expect(result.extension).toBe(extension)
  })

  it.each([
    ['non-success status', { status: 500, headers: {}, body: new Uint8Array() }],
    ['missing content length', { status: 200, headers: { 'content-type': 'image/png' }, body: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]) }],
    ['unsupported content type', { status: 200, headers: { 'content-type': 'image/svg+xml', 'content-length': '8' }, body: new Uint8Array(8) }],
    ['implicit decoding', { status: 200, headers: { 'content-type': 'image/png', 'content-length': '8', 'content-encoding': 'gzip' }, body: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]) }],
    ['magic mismatch', { status: 200, headers: { 'content-type': 'image/png', 'content-length': '8' }, body: new Uint8Array(8) }],
    ['empty body', { status: 200, headers: { 'content-type': 'image/png', 'content-length': '0' }, body: new Uint8Array() }],
  ] as const)('rejects unsafe response: %s', async (_case, response) => {
    await expect(acquireRemoteImage('https://images.example/file', {
      maxBytes: 64, maxRedirects: 0, timeoutMs: 1000,
      resolve: async () => ['93.184.216.34'], request: async () => response,
    })).rejects.toThrow('image')
  })

  it('rejects redirect loops and limits without connecting beyond the allowance', async () => {
    let requests = 0
    await expect(acquireRemoteImage('https://images.example/a', {
      maxBytes: 64, maxRedirects: 1, timeoutMs: 1000,
      resolve: async () => ['93.184.216.34'],
      request: async ({ url }) => { requests += 1; return { status: 302, headers: { location: url.endsWith('/a') ? '/b' : '/a' }, body: new Uint8Array() } },
    })).rejects.toThrow('redirect')
    expect(requests).toBe(2)
  })
})
