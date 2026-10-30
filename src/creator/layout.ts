import type { CliGateway } from '../cli/gateway.ts'
import { creatorRemoteError, creatorCliError } from './errors.ts'

export const MAX_LAYOUT_MODULES = 8

/** Count actual module openings, ignoring Markdown code examples. */
export function countLayoutModules(markdown: string): number {
  let fence = ''; let count = 0
  for (const line of markdown.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1]
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ''; continue }
    if (!fence && /^\s*:::\s*[a-z][\w-]*(?:\s|$)/iu.test(line)) count++
  }
  return count
}
export function assertLayoutLimit(markdown: string): void {
  if (countLayoutModules(markdown) > MAX_LAYOUT_MODULES) throw creatorRemoteError(undefined, 'LAYOUT_LIMIT')
}
export const LAYOUT_INSTRUCTIONS = [
  '使用 md2wechat layout 能力，按文章内容、阅读节奏和目标自动选择高级排版模块，不是泛泛的文字润色建议。',
  '整篇文章高级排版模块总数不超过 8 个，已有模块也计入；按需选择，不为凑数堆满。优先考虑 hero、cta、cards 等，教程、报告可选择更合适的模块。',
  '动画分割线可考虑 section-title 的 divider 变体与 motion: draw-center，但必须先核对当前模块定义允许该组合；微信内动效表现不作保证。动画分割线只有当前 CLI 的模块定义明确支持时才使用；不得臆造 divider、动画参数或模块语法。不要插入脚本、事件属性或自定义动画 HTML。',
  '以提供的当前 CLI 模块目录和定义为准，只使用已提供完整定义的模块。保留文章事实、原意和已有图片，不编造 CTA 链接、优惠或读者收益。',
  '将整套排版输出为 1 组精确 before/after 建议，包含所有建议模块；用户确认后才应用，模块总数仍不得超过 8。不要改写原文件，不调用在线排版、上传或草稿。',
].join('\n')

/** Discover installed definitions, never hard-code unverified module fields. */
export async function prepareLayoutRequest(gateway: CliGateway, markdown: string, signal: AbortSignal): Promise<unknown> {
  const catalog = await gateway.run(['layout', 'list', '--json'], { signal })
  if (!catalog.success) throw creatorCliError(catalog)
  const modules = catalog.data?.modules
  if (catalog.code !== 'LAYOUT_SHOWN' || catalog.status !== 'completed' || !Array.isArray(modules)) throw creatorRemoteError(undefined, 'CLI_UNAVAILABLE')
  const names = new Set(modules.flatMap(item => item && typeof item === 'object' && 'name' in item && typeof item.name === 'string' ? [item.name] : []))
  const definitions = []
  for (const name of ['hero', 'cta', 'cards', 'part', 'split', 'section-title', 'quote-card', 'steps']) {
    if (!names.has(name)) continue
    const definition = await gateway.run(['layout', 'show', name, '--json'], { signal })
    if (!definition.success) throw creatorCliError(definition)
    if (definition.code !== 'LAYOUT_SHOWN' || definition.status !== 'completed' || !definition.data?.spec) throw creatorRemoteError(undefined, 'CLI_UNAVAILABLE')
    definitions.push(definition.data.spec)
  }
  if (!definitions.length) throw creatorRemoteError(undefined, 'CLI_UNAVAILABLE')
  return { catalog: modules, definitions, existingModules: countLayoutModules(markdown), maxModules: MAX_LAYOUT_MODULES }
}
