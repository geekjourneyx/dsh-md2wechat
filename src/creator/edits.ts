/** Exact, reviewable patches. They never silently rewrite the full article. */
export interface ProposedChange { title: string; reason: string; before: string; after: string }

export function validateSuggestions(value: readonly ProposedChange[]): ProposedChange[] {
  if (!Array.isArray(value) || value.length > 3) throw new Error('一次最多提供 3 条建议。')
  return value.map(change => {
    if (!change || typeof change !== 'object' || Object.keys(change).some(key => !['title', 'reason', 'before', 'after'].includes(key))) throw new Error('建议格式无效。')
    if (typeof change.title !== 'string' || !change.title.trim() || change.title.length > 100
      || typeof change.reason !== 'string' || !change.reason.trim() || change.reason.length > 600
      || typeof change.before !== 'string' || !change.before || change.before.length > 12000
      || typeof change.after !== 'string' || change.after.length > 16000 || change.before === change.after) throw new Error('建议内容无效或过长。')
    if (/<\s*(?:script|iframe|object|embed|form|style)\b|\bon\w+\s*=|javascript:/iu.test(change.after)) throw new Error('建议包含不支持的可执行内容。')
    return { ...change }
  })
}

export function applyExactChange(markdown: string, change: ProposedChange): string {
  validateSuggestions([change])
  const start = markdown.indexOf(change.before)
  if (start < 0) throw new Error('原文已经变化，请重新生成建议。')
  if (markdown.indexOf(change.before, start + 1) !== -1) throw new Error('相同原文出现多处，请提供更精确的建议。')
  let fence: string | undefined
  let offset = 0
  for (const line of markdown.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1]
    const wasFenced = !!fence
    if (marker) fence = fence && marker[0] === fence[0] && marker.length >= fence.length ? undefined : fence ?? marker
    if (offset < start + change.before.length && start < offset + line.length + 1 && (fence || wasFenced || marker)) throw new Error('不自动修改代码块，请手动调整。')
    offset += line.length + 1
  }
  return markdown.slice(0, start) + change.after + markdown.slice(start + change.before.length)
}
