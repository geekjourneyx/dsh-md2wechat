import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  applyBodyImage,
  createCoverRequests,
  paragraphImageAnchors,
  rebindImageCandidate,
  selectImageCandidates,
  verifyImageCandidate,
} from '../../src/creator/image-choices.ts'
import type { ImageCandidate } from '../../src/creator/image-choices.ts'
import { discoverMarkdownImageDestinations } from '../../src/tools/preview.ts'

const revision = 'a'.repeat(64)
const nextRevision = 'b'.repeat(64)
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const candidate = (id: string, kind: 'cover' | 'body' = 'cover'): ImageCandidate => ({
  id, revisionId: revision, kind, path: `revisions/${revision}/images/${id}.png`,
  sha256: digest(png), contentType: 'image/png', byteSize: png.byteLength, alt: '文章配图',
})

describe('revision-bound image choices', () => {
  it('prepares three distinct optional cover requests without selecting or generating them', () => {
    const requests = createCoverRequests(revision, '关于城市公共空间')
    expect(requests).toHaveLength(3)
    expect(new Set(requests.map(item => item.id)).size).toBe(3)
    expect(new Set(requests.map(item => item.preset)).size).toBe(3)
    expect(requests.every(item => item.kind === 'cover' && item.targetPath.startsWith('images/'))).toBe(true)
    expect(requests).toEqual(createCoverRequests(revision, '关于城市公共空间'))
    expect(createCoverRequests(nextRevision, '关于城市公共空间')[0]!.id).not.toBe(requests[0]!.id)
    expect(() => createCoverRequests('stale', '主题')).toThrow()
    expect(() => createCoverRequests(revision, '')).toThrow()
  })

  it('keeps three visible candidates but selects just one cover for delivery', () => {
    const candidates = [candidate('one'), candidate('two'), candidate('three')]
    const selected = selectImageCandidates(revision, candidates, { coverId: 'two', bodyIds: [] })
    expect(selected).toEqual({ cover: candidates[1], body: [] })
    expect(candidates).toHaveLength(3)
    expect(selectImageCandidates(revision, candidates, { bodyIds: [] })).toEqual({ body: [] })
    selected.cover!.alt = '修改返回值'
    expect(candidates[1]!.alt).toBe('文章配图')
  })

  it('does not accept stale, forged, wrong-kind or duplicate selections', () => {
    const candidates = [candidate('one'), candidate('body', 'body')]
    expect(() => selectImageCandidates(nextRevision, candidates, { coverId: 'one', bodyIds: [] })).toThrow('版本')
    expect(() => selectImageCandidates(revision, candidates, { coverId: 'unknown', bodyIds: [] })).toThrow('候选')
    expect(() => selectImageCandidates(revision, candidates, { coverId: 'body', bodyIds: [] })).toThrow('封面')
    expect(() => selectImageCandidates(revision, candidates, { bodyIds: ['one'] })).toThrow('正文')
    expect(() => selectImageCandidates(revision, candidates, { bodyIds: ['body', 'body'] })).toThrow('重复')
    expect(() => selectImageCandidates(revision, [candidate('one'), candidate('one')], { bodyIds: [] })).toThrow('重复')
  })

  it('creates distinct exact anchors for repeated paragraphs', () => {
    const markdown = '# 标题\n\n重复正文。\n\n重复正文。\n'
    const anchors = paragraphImageAnchors(revision, markdown)
    expect(anchors).toHaveLength(2)
    expect(anchors.map(anchor => anchor.context)).toEqual(['重复正文。', '重复正文。'])
    expect(anchors[0]!.id).not.toBe(anchors[1]!.id)
    expect(applyBodyImage(revision, markdown, anchors[1]!, candidate('body', 'body'))).toBe(
      '# 标题\n\n重复正文。\n\n重复正文。\n\n![文章配图](images/body.png)\n',
    )
  })

  it('replaces one paragraph image without changing another position', () => {
    const markdown = '# 标题\n\n第一段。\n\n![旧图](images/old.png)\n\n第二段。\n\n![另图](images/other.png)\n'
    const anchors = paragraphImageAnchors(revision, markdown)
    expect(anchors).toHaveLength(2)
    expect(anchors[0]!.image?.source).toBe('images/old.png')
    expect(applyBodyImage(revision, markdown, anchors[0]!, candidate('new', 'body'))).toBe(
      '# 标题\n\n第一段。\n\n![文章配图](images/new.png)\n\n第二段。\n\n![另图](images/other.png)\n',
    )
    expect(applyBodyImage(revision, markdown, anchors[0]!, null)).toBe(
      '# 标题\n\n第一段。\n\n\n\n第二段。\n\n![另图](images/other.png)\n',
    )
  })

  it('rejects stale and tampered anchors rather than searching for matching text', () => {
    const markdown = '原段落。'
    const anchor = paragraphImageAnchors(revision, markdown)[0]!
    expect(() => applyBodyImage(nextRevision, markdown, anchor, candidate('body', 'body'))).toThrow('版本')
    expect(() => applyBodyImage(revision, `${markdown}\n修改`, anchor, candidate('body', 'body'))).toThrow('变化')
    expect(() => applyBodyImage(revision, markdown, { ...anchor, end: 0 }, candidate('body', 'body'))).toThrow('位置')
    expect(() => applyBodyImage(revision, markdown, anchor, candidate('cover'))).toThrow('正文')
  })

  it('does not suggest placements in code, YAML, tables, lists, quotes, HTML or custom modules', () => {
    const markdown = [
      '---', 'title: 封面', '---', '', '# 标题', '',
      '```md', '代码里的段落', '', '![代码图](images/code.png)', '```', '',
      ':::card', '模块里的段落', '', ':::nested', '嵌套模块', ':::', ':::', '',
      '<section>', 'HTML 里面', '', '</section>', '',
      '> 引用', '> 继续', '', '- 列表', '  列表延续', '',
      '    缩进代码', '', '| 第一列 | 第二列 |', '| --- | --- |', '| A | B |', '',
      '正常段落。',
    ].join('\n')
    const anchors = paragraphImageAnchors(revision, markdown)
    expect(anchors.map(anchor => anchor.context)).toEqual(['正常段落。'])
    expect(applyBodyImage(revision, markdown, anchors[0]!, candidate('body', 'body'))).toBe(
      `${markdown}\n\n![文章配图](images/body.png)`,
    )
  })

  it('retains CRLF and makes alt text safe for the existing Markdown image contract', () => {
    const markdown = '# 标题\r\n\r\n段落。\r\n'
    const anchor = paragraphImageAnchors(revision, markdown)[0]!
    const body = { ...candidate('body', 'body'), alt: '图] ![bad](https://bad.test)\nnext' }
    expect(applyBodyImage(revision, markdown, anchor, body)).toBe(
      '# 标题\r\n\r\n段落。\r\n\r\n![图］ !［bad］(https://bad.test) next](images/body.png)\r\n',
    )
    expect(discoverMarkdownImageDestinations(new TextEncoder().encode(applyBodyImage(revision, markdown, anchor, body)))).toEqual(['images/body.png'])
  })

  it('locates existing hero and consecutive images even without a preceding paragraph', () => {
    const markdown = '# 标题\n\n![开头](https://example.test/hero.png)\n\n![第二张](images/two.png)\n'
    const anchors = paragraphImageAnchors(revision, markdown)
    expect(anchors).toHaveLength(2)
    expect(anchors[0]!.context).toBe('标题')
    expect(anchors[0]!.image?.source).toBe('https://example.test/hero.png')
    expect(applyBodyImage(revision, markdown, anchors[1]!, candidate('new', 'body'))).toBe(
      '# 标题\n\n![开头](https://example.test/hero.png)\n\n![文章配图](images/new.png)\n',
    )
  })

  it('keeps lazy block continuations, setext headings, comments and display math out of placements', () => {
    const markdown = [
      '次级标题', '======', '', '> 引用', '引用的延续', '',
      '- 清单', '清单的延续', '', '<!--', '隐藏内容', '', '-->', '',
      '$$', 'a + b', '', 'c = d', '$$', '', '普通正文。',
    ].join('\n')
    expect(paragraphImageAnchors(revision, markdown).map(anchor => anchor.context)).toEqual(['普通正文。'])
  })

  it('verifies current candidate bytes, type, size and digest using a bounded artifact read', async () => {
    const image = candidate('one')
    const reads: unknown[] = []
    const verified = await verifyImageCandidate({
      readBounded: async (...args) => { reads.push(args); return png },
    }, revision, image)
    expect(verified).toEqual(image)
    expect(reads).toEqual([[image.path, image.byteSize, undefined]])
    await expect(verifyImageCandidate({ readBounded: async () => Uint8Array.from([...png, 1]) }, revision, image)).rejects.toThrow('变化')
    await expect(verifyImageCandidate({ readBounded: async () => Uint8Array.from([1, ...png.slice(1)]) }, revision, image)).rejects.toThrow('变化')
    await expect(verifyImageCandidate({ readBounded: async () => png }, revision, { ...image, contentType: 'image/jpeg' })).rejects.toThrow()
    const invalid = new Uint8Array(png.byteLength)
    await expect(verifyImageCandidate({ readBounded: async () => invalid }, revision, { ...image, sha256: digest(invalid) })).rejects.toThrow('raster content type')
  })

  it('rejects arbitrary paths and URLs before reading and does not carry client media authority', async () => {
    let reads = 0
    const store = { readBounded: async () => { reads++; return png } }
    for (const path of ['https://example.test/image.png', '/tmp/image.png', `revisions/${revision}/images/../../private.png`, `revisions/${nextRevision}/images/one.png`]) {
      await expect(verifyImageCandidate(store, revision, { ...candidate('one'), path })).rejects.toThrow()
    }
    expect(reads).toBe(0)
    const image = { ...candidate('one'), mediaId: 'forged', planPath: 'old-plan.json' }
    const verified = await verifyImageCandidate(store, revision, image)
    expect(verified).not.toHaveProperty('mediaId')
    expect(verified).not.toHaveProperty('planPath')
  })

  it('rebinds only after rechecking the old and new revision asset bytes', async () => {
    const image = candidate('one')
    const reads: string[] = []
    const next = await rebindImageCandidate({ readBounded: async path => { reads.push(path); return png } }, image, nextRevision)
    expect(next.revisionId).toBe(nextRevision)
    expect(next.path).toBe(`revisions/${nextRevision}/images/one.png`)
    expect(reads).toEqual([image.path, next.path])
    await expect(rebindImageCandidate({
      readBounded: async path => path === image.path ? png : Uint8Array.from([...png, 1]),
    }, image, nextRevision)).rejects.toThrow('变化')
  })

  it('aborts before reading an asset when generation or selection was cancelled', async () => {
    const controller = new AbortController(); controller.abort(new Error('已取消'))
    let reads = 0
    await expect(verifyImageCandidate({ readBounded: async () => { reads++; return png } }, revision, candidate('one'), controller.signal)).rejects.toThrow('已取消')
    expect(reads).toBe(0)
  })
})
