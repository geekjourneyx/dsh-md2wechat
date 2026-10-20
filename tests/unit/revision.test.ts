import { PLUGIN_VERSION } from '../../src/version.ts'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
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
      pluginVersion: PLUGIN_VERSION,
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

  it('requires the immutable revision timestamp to use canonical UTC ISO encoding', () => {
    expect(() => validateRevisionManifest({ ...manifest, createdAt: '2026-08-25T08:00:00+08:00' })).toThrow('canonical ISO')
    expect(() => validateRevisionManifest({ ...manifest, createdAt: '2026-08-25' })).toThrow('canonical ISO')
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
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path =>
      import('node:fs/promises').then(fs => fs.rm(path, { recursive: true, force: true }))))
  })

  it('appends canonical redacted JSON lines with monotonic sequence numbers', async () => {
    const files = new Map<string, Uint8Array>()
    const store = {
      async canonicalIdentity(path: string): Promise<string> {
        return `memory-root/${path}`
      },
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

  it('serializes concurrent appends from separate stores sharing one canonical operations file', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'dsh-md2wechat-shared-records-'))
    temporaryDirectories.push(temporary)
    const workspace = join(temporary, 'workspace')
    await mkdir(workspace)
    const fs = {
      async resolve(path: string) {
        const absolute = resolve(workspace, path)
        return { targetKey: absolute, displayPath: absolute }
      },
      processPath(target: { targetKey: string }) { return target.targetKey },
      contains(parent: { targetKey: string }, child: { targetKey: string }) {
        const candidate = relative(parent.targetKey, child.targetKey)
        return candidate === '' || (!candidate.startsWith('..') && !isAbsolute(candidate))
      },
      async readBytes(target: { targetKey: string }, _signal: AbortSignal | undefined, maxBytes: number) {
        try {
          const bytes = await readFile(target.targetKey)
          if (bytes.byteLength > maxBytes) throw new Error('too large')
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
    const firstStore = new ArtifactStore(fs as never, workspace, '.dsh/md2wechat')
    const secondStore = new ArtifactStore(fs as never, workspace, '.dsh/md2wechat')
    const revision = computeArticleRevision(new TextEncoder().encode('# Article\n'), manifest)

    await Promise.all([
      appendOperation(firstStore, revision, {
        operation: 'advise',
        createdAt: '2026-08-25T00:00:01.000Z',
        details: {},
      }, []),
      appendOperation(secondStore, revision, {
        operation: 'humanize',
        createdAt: '2026-08-25T00:00:02.000Z',
        details: {},
      }, []),
    ])

    const text = new TextDecoder().decode(await firstStore.read(`revisions/${revision.id}/operations.jsonl`))
    const records = text.trimEnd().split('\n').map(line => JSON.parse(line) as { sequence: number })
    expect(records.map(record => record.sequence)).toEqual([1, 2])
  })
})

describe('shared tool results', () => {
  it('adds plugin and CLI versions independently without mutating fields', () => {
    const fields = { ok: true } as const
    expect(domainResult(fields)).toEqual({ ok: true, pluginVersion: PLUGIN_VERSION, cliVersion: '3.3.0' })
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
