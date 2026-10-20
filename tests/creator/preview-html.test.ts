// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { hydratePreviewHtml } from '../../src/client/preview-html.ts'
it('uses verified bytes for escaped local names and final WeChat URL query values', () => {
  expect(hydratePreviewHtml('<p>原样保留</p><img src="images/a&amp;b.png"><img src=\'https://mmbiz.qpic.cn/x?a=1&amp;copy;=2\'>', [
    { source: 'images/a&b.png', dataUrl: 'data:image/png;base64,one' },
    { source: 'https://mmbiz.qpic.cn/x?a=1&copy;=2', dataUrl: 'data:image/png;base64,two' },
  ])).toBe('<p>原样保留</p><img src="data:image/png;base64,one"><img src=\'data:image/png;base64,two\'>')
})
it('fails visibly when verified inventory cannot be displayed rather than silently loading a wrong resource', () => {
  expect(() => hydratePreviewHtml('<img src="wrong.png">', [{ source: 'right.png', dataUrl: 'data:image/png;base64,x' }])).toThrow('定位')
  expect(() => hydratePreviewHtml('<img src="a" src="b">', [])).toThrow('歧义')
})
