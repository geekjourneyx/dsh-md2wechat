import type { CreatorInspection } from './types.ts'

/** Keep CLI diagnostics structured and do not expose local paths or provider details. */
export function inspectionView(data: unknown): CreatorInspection {
  if (!data || typeof data !== 'object') throw new Error('文章检查未返回有效结果。')
  const value = data as { checks?: unknown; readiness?: { draft_ready?: unknown } }
  if (!Array.isArray(value.checks) || typeof value.readiness?.draft_ready !== 'boolean') throw new Error('文章检查未返回有效结果。')
  const labels: Record<string, string> = {
    MISSING_COVER: '请选择一张封面。', DUPLICATE_H1: '正文开头与文章标题重复，可以按需要保留或调整。',
    TITLE_TOO_LONG: '标题超过长度限制，请缩短。', MISSING_TITLE: '请补充文章标题。',
    MISSING_IMAGE: '文章中有图片无法读取，请重新选择图片。',
  }
  return { ready: value.readiness.draft_ready, checks: value.checks.slice(0, 100).map(item => {
    if (!item || typeof item !== 'object') throw new Error('文章检查未返回有效结果。')
    const check = item as { code?: unknown; level?: unknown }
    if (typeof check.code !== 'string' || !['error', 'warn', 'info'].includes(String(check.level))) throw new Error('文章检查未返回有效结果。')
    return { level: check.level as 'error' | 'warn' | 'info', message: labels[check.code] ?? (check.level === 'error' ? '文章有未解决的发布问题，请检查标题、正文和图片。' : '建议再次核对文章内容和图片显示效果。') }
  }) }
}
