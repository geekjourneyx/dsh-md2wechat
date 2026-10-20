import { describe, expect, it } from 'vitest'
import { applyExactChange, validateSuggestions } from '../../src/creator/edits.ts'
const suggestion = { title: '加一处小标题', reason: '方便阅读', before: '段落。', after: '## 要点\n\n段落。' }
describe('reviewed exact edits', () => {
  it('only applies an unambiguous exact before fragment', () => {
    expect(applyExactChange('# 标题\n\n段落。', suggestion)).toBe('# 标题\n\n## 要点\n\n段落。')
    expect(() => applyExactChange('段落。\n段落。', suggestion)).toThrow('多处')
    expect(() => applyExactChange('已经改过', suggestion)).toThrow('变化')
  })
  it('caps suggestions at three, validates bounds and does not accept silent no-op changes', () => {
    expect(validateSuggestions([suggestion])).toHaveLength(1)
    expect(() => validateSuggestions([suggestion, suggestion, suggestion, suggestion])).toThrow('3')
    expect(() => validateSuggestions([{ ...suggestion, before: '' }])).toThrow()
    expect(() => validateSuggestions([{ ...suggestion, after: suggestion.before }])).toThrow()
  })
  it('refuses edits inside code fences and introduction of active HTML', () => {
    expect(() => applyExactChange('```md\n段落。\n```', suggestion)).toThrow('代码')
    expect(() => validateSuggestions([{ ...suggestion, after: '<script>bad()</script>' }])).toThrow()
  })
})

it('does not let a patch starting before a fence rewrite code', () => {
  expect(() => applyExactChange('Intro\n```js\ncode()\n```\nEnd', { title: 'x', reason: 'x', before: 'Intro\n```js\ncode()', after: 'New intro' })).toThrow('代码')
})
