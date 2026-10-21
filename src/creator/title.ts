/** Keep a YAML scalar title consistent, including folded/literal block scalars. */
export function withFrontmatterTitle(markdown: string, title: string): string {
 return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, front => front.replace(/^title\s*:[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/mu, () => `title: ${JSON.stringify(title)}`))
}
/** Change the visible opening heading and the publication title together. */
export function replaceArticleTitle(markdown: string, title: string): string {
 if (typeof title !== 'string' || !title.trim() || [...title.trim()].length > 32 || !title.isWellFormed() || /[<>]/u.test(title) || [...title].some(character => character.charCodeAt(0) < 32)) throw new Error('[md2wechat:TITLE_INVALID]')
 title = title.trim()
 let prefix = ''; let body = withFrontmatterTitle(markdown, title)
 const front = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(body)
 if (front) { prefix = front[0]; body = body.slice(front[0].length) }
 const opening = /^(\s*)# [^\r\n]*(?:\r?\n|$)/u
 body = opening.test(body) ? body.replace(opening, (_all, whitespace: string) => `${whitespace}# ${title}\n`) : `# ${title}\n\n${body}`
 return prefix + body
}
