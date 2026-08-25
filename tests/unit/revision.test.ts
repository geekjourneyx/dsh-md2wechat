import { describe, expect, it } from 'vitest'
import { domainResult, genericCall, genericResult } from '../../src/tools/shared.ts'
import { ArtifactStore } from '../../src/workspace/artifact-store.ts'
import {
  appendOperation,
  computeArticleRevision,
  validateRevisionManifest,
} from '../../src/workspace/revision.ts'
import type { ArticleManifest } from '../../src/workspace/revision.ts'

const manifest: ArticleManifest = {
  schemaVersion: 1,
  articlePath: 'revisions/article.md',
  manifestPath: 'revisions/manifest.json',
  createdAt: '2026-08-25T00:00:00.000Z',
  title: 'Example',
  parentRevisionId: 'parent-001',
}

describe('article revisions', () => {
  it('hashes canonical UTF-8 article bytes with normalized manifest fields', () => {
    const bytes = new TextEncoder().encode('# Article\n')
    const reordered = {
      parentRevisionId: 'parent-001',
      title: 'Example',
      createdAt: '2026-08-25T00:00:00.000Z',
      manifestPath: 'revisions/manifest.json',
      articlePath: 'revisions/article.md',
      schemaVersion: 1 as const,
    }

    const first = computeArticleRevision(bytes, manifest)
    const second = computeArticleRevision(bytes, reordered)

    expect(second).toEqual(first)
    expect(first).toMatchObject({
      articlePath: 'revisions/article.md',
      manifestPath: 'revisions/manifest.json',
      pluginVersion: '1.0.0',
      cliVersion: '3.3.0',
      createdAt: '2026-08-25T00:00:00.000Z',
    })
    expect(first.id).toMatch(/^[a-f0-9]{64}$/u)
    expect(first.articleSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(computeArticleRevision(new TextEncoder().encode('# Changed\n'), manifest).id).not.toBe(first.id)
    expect(computeArticleRevision(bytes, { ...manifest, title: 'Changed' }).id).not.toBe(first.id)
  })

  it('rejects invalid UTF-8 article bytes', () => {
    expect(() => computeArticleRevision(Uint8Array.from([0xff]), manifest)).toThrow('UTF-8')
  })

  it('rejects unknown schemas, unknown fields, parent segments, and separators in revision IDs', () => {
    expect(() => validateRevisionManifest({ ...manifest, schemaVersion: 2 })).toThrow('schema')
    expect(() => validateRevisionManifest({ ...manifest, unexpected: true })).toThrow('field')
    expect(() => validateRevisionManifest({ ...manifest, articlePath: '../article.md' })).toThrow('parent')
    expect(() => validateRevisionManifest({ ...manifest, parentRevisionId: 'parent/child' })).toThrow('separator')
    expect(() => validateRevisionManifest({ ...manifest, parentRevisionId: 'parent\\child' })).toThrow('separator')
  })
})

describe('operation records', () => {
  it('appends canonical redacted JSON lines with monotonic sequence numbers', async () => {
    const files = new Map<string, Uint8Array>()
    const store = {
      async read(path: string): Promise<Uint8Array> {
        const bytes = files.get(path)
        if (bytes !== undefined) return bytes
        const missing = new Error('file not found') as Error & { code: string }
        missing.code = 'FS_NOT_FOUND'
        throw missing
      },
      async writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
        files.set(path, bytes)
      },
    } as ArtifactStore
    const revision = computeArticleRevision(new TextEncoder().encode('# Article\n'), manifest)
    await Promise.all([
      appendOperation(store, revision, {
        operation: 'advise',
        createdAt: '2026-08-25T00:00:01.000Z',
        details: { note: 'credential=top-secret', apiKey: 'top-secret', z: 2, a: 1 },
      }, ['top-secret']),
      appendOperation(store, revision, {
        operation: 'humanize',
        createdAt: '2026-08-25T00:00:02.000Z',
        details: { result: 'complete' },
      }, ['top-secret']),
    ])

    const text = new TextDecoder().decode(await store.read(`revisions/${revision.id}/operations.jsonl`))
    const lines = text.trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('{"createdAt":"2026-08-25T00:00:01.000Z","details":{"a":1,"apiKey":"[REDACTED]","note":"credential=[REDACTED]","z":2},"operation":"advise","revisionId":"' + revision.id + '","schemaVersion":1,"sequence":1}')
    expect(JSON.parse(lines[1]!)).toMatchObject({ sequence: 2, operation: 'humanize', revisionId: revision.id })
    expect(text).not.toContain('top-secret')
  })
})

describe('shared tool results', () => {
  it('adds plugin and CLI versions independently without mutating fields', () => {
    const fields = { ok: true } as const
    expect(domainResult(fields)).toEqual({ ok: true, pluginVersion: '1.0.0', cliVersion: '3.3.0' })
    expect(fields).toEqual({ ok: true })
  })

  it('creates pure generic cards from explicit display data', () => {
    expect(genericCall('Read article', 'read', 'article.md', ['article.md'])).toEqual({
      card: 'generic',
      title: 'Read article',
      kind: 'read',
      rawInput: 'article.md',
      locations: [{ path: 'article.md' }],
    })
    expect(genericResult('Article ready')).toEqual({ card: 'generic', title: 'Article ready' })
  })
})
