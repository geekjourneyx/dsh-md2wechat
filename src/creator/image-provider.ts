export interface CreatorImageProvider { env: Record<string, string>; origin: string }
/** Capture only operator-supplied host environment, never article-directory configuration. */
export function creatorImageProvider(environment: Readonly<Record<string, string | undefined>>): CreatorImageProvider {
  const aliases: Record<string, string> = { openai: 'openai', modelscope: 'modelscope', ms: 'modelscope', openrouter: 'openrouter', or: 'openrouter', volcengine: 'volcengine', volc: 'volcengine', tuzi: 'tuzi' }
  const provider = aliases[environment.IMAGE_PROVIDER?.trim().toLowerCase() || 'openai']
  if (!provider) throw new Error('此备用图片服务尚未验证，请使用宿主图片能力或本地图片。')
  const defaults: Record<string, string> = { openai: 'https://api.openai.com/v1', modelscope: 'https://api-inference.modelscope.cn', openrouter: 'https://openrouter.ai/api/v1', volcengine: 'https://ark.cn-beijing.volces.com/api/v3' }
  const base = environment.IMAGE_API_BASE?.trim() || defaults[provider]
  if (!base) throw new Error('请先在宿主环境中配置 IMAGE_API_BASE。')
  const url = new URL(base)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('备用图片服务必须使用不含凭据或查询参数的 HTTPS 地址。')
  const model = environment.IMAGE_MODEL?.trim() ?? ''
  const size = environment.IMAGE_SIZE?.trim() ?? ''
  if ([model, size].some(value => value.length > 200 || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) throw new Error('备用图片服务参数无效。')
  return { env: { IMAGE_PROVIDER: provider, IMAGE_API_BASE: url.href.replace(/\/$/u, ''), IMAGE_MODEL: model, IMAGE_SIZE: size }, origin: url.origin }
}
