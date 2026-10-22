import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUiApproval } from '../../src/creator/ui-approval.ts'
import type { OperationTurnRunner } from '../../src/creator/operation-turn.ts'

describe('UI approval boundary', () => {
  it('finishes the host approval turn before returning permission to the direct operation', async () => {
    let inTurn = false
    const events: string[] = []
    const runner: OperationTurnRunner = {
      async run(_agent, signal, operation) {
        signal.throwIfAborted(); inTurn = true; events.push('approval-start')
        const result = await operation(signal)
        inTurn = false; events.push('approval-end'); return result
      }, dispose() {},
    }
    const request = vi.fn(async () => { expect(inTurn).toBe(true); return 'allowed-once' as const })
    const signal = new AbortController().signal
    const outcome = await createUiApproval({ request }, runner).request({ agent: {} as Agent, toolName: 'preview', callId: 'test' as never, reason: 'preview', signal })
    expect(outcome).toBe('allowed-once')
    expect(inTurn).toBe(false)
    events.push('direct-cli')
    expect(events).toEqual(['approval-start', 'approval-end', 'direct-cli'])
  })
  it('preserves rejection and abort without granting permission', async () => {
    const runner: OperationTurnRunner = { async run(_agent, signal, operation) { signal.throwIfAborted(); return operation(signal) }, dispose() {} }
    const request = vi.fn(async () => 'rejected' as const)
    const approval = createUiApproval({ request }, runner)
    const controller = new AbortController()
    const args = { agent: {} as Agent, toolName: 'draft', callId: 'test' as never, reason: 'draft', signal: controller.signal }
    expect(await approval.request(args)).toBe('rejected')
    controller.abort()
    await expect(approval.request(args)).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(1)
  })
})
