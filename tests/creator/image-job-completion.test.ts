import { expect, it, vi } from 'vitest'
import type { JobHooks, JobOutcome, JobSpec } from '@deepseek-ai/dsh-jobs'
import { observeCreatorImageJob } from '../../src/creator/runtime.ts'

it.each(['failed', 'killed', 'completed'] as const)('observes delayed %s outcomes while preserving producer hooks', async status => {
  let finish!: (outcome: JobOutcome) => void
  const hooks: JobHooks = { done: new Promise(resolve => { finish = resolve }), cancel: vi.fn() }
  const run = vi.fn(() => hooks)
  let captured!: JobSpec
  const observed = observeCreatorImageJob({ start: spec => { captured = spec; return 'image-job' as never }, get: vi.fn() })
  observed.jobs.start({ kind: 'md2wechat-image', label: 'test', run })
  expect(run).not.toHaveBeenCalled()
  const handle = {} as never
  expect(captured.run(handle)).toBe(hooks)
  expect(run).toHaveBeenCalledExactlyOnceWith(handle)
  hooks.cancel()
  expect(hooks.cancel).toHaveBeenCalledOnce()
  const settled = observed.completion.then(() => 'completed', () => 'error')
  finish({ status })
  expect(await settled).toBe(status === 'completed' ? 'completed' : 'error')
})
