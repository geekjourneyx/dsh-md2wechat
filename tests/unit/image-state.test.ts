import { describe, expect, it } from 'vitest'
import {
  acquireImageClaim,
  acquireRemoteImage,
  canonicalImagePlanId,
  encodeCanonical,
  isPublicNetworkAddress,
  loadImagePlan,
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
    'fe80::1', 'ff00::1', '::ffff:127.0.0.1', '2001:db8::1',
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

  it('strictly loads the canonical Task 5 plan and rejects unknown fields or changed IDs', async () => {
    const revisionId = 'a'.repeat(64)
    const item = {
      original: { id: 'hero', kind: 'image', prompt: 'raw', targetPath: 'images/hero.png' },
      targetArtifactPath: `revisions/${revisionId}/images/hero.png`,
      cliPlan: {
        mode: 'plan', command: 'generate_image', execution_owner: 'host_agent', side_effects: false,
        requires_provider: false, requires_image_api_key: false, prompt: 'rendered', raw_prompt: 'raw', preset: '',
        archetype: '', primary_use_case: '', compatible_use_cases: [], recommended_aspect_ratios: [],
        default_aspect_ratio: '', article: '', title: '', summary: '', keywords: '', style: '', aspect: '', size: '',
        model_hint: '', suggested_filename: '', alt_text: '',
      },
    }
    const items = [item]
    const planId = canonicalImagePlanId(revisionId, items)
    const value = { schemaVersion: 1, planId, revisionId, createdAt: '2026-08-25T00:00:00.000Z', items }
    const store = { read: async () => encodeCanonical(value) }
    const plan = await loadImagePlan(store as never, `revisions/${revisionId}/plans/${planId}.json`, revisionId, `revisions/${revisionId}/article.md`)
    expect(plan.items[0]).toMatchObject({ id: 'hero', prompt: 'rendered', targetPath: `revisions/${revisionId}/images/hero.png` })
    const unknown = { ...value, debug: 'secret' }
    await expect(loadImagePlan({ read: async () => encodeCanonical(unknown) } as never, plan.path, revisionId, `revisions/${revisionId}/article.md`)).rejects.toThrow('unknown')
  })

  it('creates one exclusive claim across stores and releases only matching ownership', async () => {
    const files = new Map<string, Uint8Array>()
    const fakeStore = () => ({
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
      async createExclusive(path: string, bytes: Uint8Array) { if (files.has(path)) { const error = new Error('exists') as Error & { code: string }; error.code = 'ARTIFACT_EXISTS'; throw error }; files.set(path, bytes); return { created: true } },
      async read(path: string) { return files.get(path)! },
      async removeIfMatching(path: string, expected: string) { const bytes = files.get(path); if (bytes !== undefined && (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex') === expected) files.delete(path) },
    }
    const plan = { revisionId: 'a'.repeat(64), planId: 'b'.repeat(64) } as never
    const item = { id: 'hero', targetPath: `revisions/${'a'.repeat(64)}/images/hero.png` } as never
    const common = { sessionId: 'session', now: new Date('2026-08-25T00:00:00.000Z'), staleAfterMs: 1000 }
    const old = await acquireImageClaim(store as never, plan, item, { ...common, jobId: 'md2wechat-image-1', ownerIsLive: async () => false, nonce: 'old' })
    const replacement = await acquireImageClaim(store as never, plan, item, { ...common, jobId: 'md2wechat-image-2', ownerIsLive: async () => false, nonce: 'new' })
    await releaseImageClaim(store as never, old)
    expect(files.size).toBe(1)
    await releaseImageClaim(store as never, replacement)
    expect(files.size).toBe(0)
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
