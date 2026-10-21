import { expect, it } from 'vitest'
import { replaceArticleTitle } from '../../src/creator/title.ts'
it('updates frontmatter and heading together without changing content', () => { expect(replaceArticleTitle('---\ntitle: Old\nauthor: Me\n---\n# Old\n\nBody','新标题')).toBe('---\ntitle: "新标题"\nauthor: Me\n---\n# 新标题\n\nBody') })
it('adds a title without changing code or later headings', () => { expect(replaceArticleTitle('```md\n# Code\n```','Title')).toBe('# Title\n\n```md\n# Code\n```') })
it('rejects empty, multiline and active HTML titles', () => { for (const title of ['', 'a\nb', '<script>', 'a'.repeat(33)]) expect(() => replaceArticleTitle('# Old',title)).toThrow() })

it('safely replaces a block title and treats replacement metacharacters literally', () => {
 expect(replaceArticleTitle('---\ntitle: |\n  Old\n  title\nauthor: Me\n---\n# Old', '$& 新标题')).toBe('---\ntitle: "$& 新标题"\nauthor: Me\n---\n# $& 新标题\n')
 expect(() => replaceArticleTitle('# old', '😀'.repeat(32))).not.toThrow()
})
