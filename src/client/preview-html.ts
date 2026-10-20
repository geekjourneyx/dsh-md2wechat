/** Display-only substitution. Export/draft keep the server's exact reviewed bytes. */
export function hydratePreviewHtml(html: string, images: readonly { source: string; dataUrl: string }[]): string {
  const remaining = new Map(images.map(image => [image.source, image.dataUrl]))
  if (remaining.size !== images.length) throw new Error('预览图片清单存在重复。')
  const decoder = document.createElement('textarea')
  const output = html.replace(/<img\b[^>]*>/giu, tag => {
    const matches = [...tag.matchAll(/(?:^|\s)src=(?:"([^"]*)"|'([^']*)')/giu)]
    if (matches.length !== 1) throw new Error('预览图片地址有歧义。')
    const attribute = matches[0]!
    const source = attribute[1] ?? attribute[2]!
    decoder.innerHTML = source
    const decoded = decoder.value
    const dataUrl = remaining.get(decoded)
    if (!dataUrl) return tag
    remaining.delete(decoded)
    const quote = attribute[1] === undefined ? "'" : '"'
    const start = attribute.index! + attribute[0].indexOf(quote) + 1
    return tag.slice(0, start) + dataUrl + tag.slice(start + source.length)
  })
  if (remaining.size) throw new Error('部分图片未能在预览中定位，请重新生成预览。')
  return output
}
