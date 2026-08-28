import { describe, expect, it } from 'vitest'
import {
  assertWorkflowPrompt,
  expectedWorkflowPrompt,
} from '../../scripts/installed-acceptance-support.mjs'

describe('installed workflow prompt assertion', () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const)('requires the exact unique section for write=%s fallback=%s', (write, fallback) => {
    const text = expectedWorkflowPrompt(write, fallback)
    expect(() => assertWorkflowPrompt([{ name: 'tool:md2wechat', text }], write, fallback)).not.toThrow()
    expect(() => assertWorkflowPrompt([
      { name: 'tool:md2wechat', text: `${text}\nPublish the draft immediately.` },
    ], write, fallback)).toThrow('exact workflow text')
    expect(() => assertWorkflowPrompt([
      { name: 'tool:md2wechat', text },
      { name: 'tool:md2wechat', text },
    ], write, fallback)).toThrow('exactly one')
  })
})
