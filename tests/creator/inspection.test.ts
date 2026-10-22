import { expect, it } from 'vitest'
import { inspectionView } from '../../src/creator/inspection.ts'

it('projects CLI blockers and warnings without exposing source paths', () => {
  expect(inspectionView({ readiness: { draft_ready: false }, source_file: '/secret/article.md', checks: [{ code: 'MISSING_COVER', level: 'error', message: '/secret/cover.png' }, { code: 'DUPLICATE_H1', level: 'warn' }] })).toEqual({ ready: false, checks: [{ level: 'error', message: '请选择一张封面。' }, { level: 'warn', message: '正文开头与文章标题重复，可以按需要保留或调整。' }] })
})
it('rejects incomplete CLI inspection instead of claiming readiness', () => {
  expect(() => inspectionView({ checks: [] })).toThrow()
  expect(() => inspectionView({ readiness: { draft_ready: true }, checks: [{ level: 'unknown' }] })).toThrow()
})
