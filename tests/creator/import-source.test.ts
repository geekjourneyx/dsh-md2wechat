import { expect, it, vi } from 'vitest'
import { importMarkdown } from '../../src/creator/import-source.ts'
const signal = new AbortController().signal
function store() { return { createExclusive: vi.fn(async (_path: string, _bytes: Uint8Array) => ({})), resolve: (path: string) => '/workspace/.md2wechat/' + path } }
it('keeps Unicode bytes and uses unique internal names for duplicate display names', async () => {
 const s = store(); const input = { name: '../中文 文件.md', markdown: '# 中文\n\n正文' }
 const a = await importMarkdown(s as never, input, signal); const b = await importMarkdown(s as never, input, signal)
 expect(a).not.toBe(b); expect(a).toMatch(/imports\/[\w-]+\/article.md$/); expect(new TextDecoder().decode(s.createExclusive.mock.calls[0]![1])).toBe(input.markdown)
})
it('refuses empty, oversized, malformed, relative-image and cancelled imports before writing', async () => {
 const s = store()
 for (const markdown of ['', ' ', 'x'.repeat(2*1024*1024+1), '\ud800', '![图](images/a.png)']) await expect(importMarkdown(s as never, { name: 'x.md', markdown }, signal)).rejects.toThrow()
 await expect(importMarkdown(s as never, { name:'x.md', markdown:'# x' }, AbortSignal.abort())).rejects.toThrow()
 expect(s.createExclusive).not.toHaveBeenCalled()
})
it('retains storage permission failures', async () => { const s = store(); s.createExclusive.mockRejectedValue(new Error('readonly')); await expect(importMarkdown(s as never, {name:'x',markdown:'# x'},signal)).rejects.toThrow('readonly') })

import { importImageBytes } from '../../src/creator/import-source.ts'
it('checks actual image bytes and refuses incorrect types, size and byte values', async () => {
 const s = store(); const png = [137,80,78,71,13,10,26,10,0]
 await expect(importImageBytes(s as never,{name:'../cover.png',contentType:'image/png',data:png},signal)).resolves.toMatch(/imports\/[\w-]+\/image.png$/)
 for (const input of [{contentType:'image/jpeg',data:png},{contentType:'image/png',data:[256]},{contentType:'image/png',data:[]},{contentType:'image/png',data:Array(8*1024*1024+1).fill(0)}]) await expect(importImageBytes(s as never,{name:'x',...input},signal)).rejects.toThrow()
 expect(s.createExclusive).toHaveBeenCalledTimes(1)
})
