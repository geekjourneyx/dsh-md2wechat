import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createOperationTurnRunner } from '../../src/creator/operation-turn.ts'

function harness() {
  const listeners = new Map<string, (...args: any[]) => any>()
  const queued: UserMessage[] = []
  const ctx = { on: (key: string, fn: (...args: any[]) => any) => { listeners.set(key, fn); return () => listeners.delete(key) }, effect: () => {} } as unknown as Context
  const agent = { id: 'a', status: 'idle', inbox: { nextTurn: queued, nextStep: [], remove(id: string) { const i = queued.findIndex(m => m.id === id); if(i < 0) return false; queued.splice(i, 1); return true }, prepend(_target: string, message: UserMessage) { queued.unshift(message) } }, followup(message: UserMessage) { queued.push(message); this.status = 'running' } } as unknown as Agent
  const runner = createOperationTurnRunner(ctx)
  async function step(next?: () => Promise<PreStepDecision>) { const messages = queued.splice(0); return listeners.get('agent/pre-step')!({ agent, messages, turn: 1, step: 1, signal: new AbortController().signal }, next ?? (async () => ({kind:'enter',messages}))) }
  return { runner, agent, queued, listeners, step }
}

describe('creator deterministic operation turn', () => {
  it('does not execute when a downstream gate removes its reservation', async () => {
    const h = harness(); const order: string[] = []
    const result = h.runner.run(h.agent, new AbortController().signal, async signal => { signal.throwIfAborted(); order.push('operation'); return 42 })
    expect(h.queued).toHaveLength(1)
    const decision = await h.step(async () => { order.push('gate'); return {kind:'enter',messages:[...h.queued]} })
    // A gate removing the message must prevent the operation.
    expect(decision.kind).toBe('enter')
    await expect(result).rejects.toThrow()
    expect(order).toEqual(['gate'])
  })
  it('completes admitted work and returns an empty first step', async () => {
    const h = harness(); const operation = vi.fn(async () => 42)
    const result = h.runner.run(h.agent,new AbortController().signal,operation)
    expect(await h.step()).toEqual({kind:'enter',messages:[]})
    await expect(result).resolves.toBe(42); expect(operation).toHaveBeenCalledTimes(1)
  })
  it('refuses busy agents and agents with pending input', async () => {
    const h = harness(); h.agent.status = 'running'
    await expect(h.runner.run(h.agent,new AbortController().signal,async()=>1)).rejects.toThrow('idle')
    h.agent.status = 'idle'; h.queued.push({id:'other'} as UserMessage)
    await expect(h.runner.run(h.agent,new AbortController().signal,async()=>1)).rejects.toThrow('idle')
  })
  it('honors rejecting gates without executing', async () => {
    const h=harness(); const operation=vi.fn(async()=>1);const result=h.runner.run(h.agent,new AbortController().signal,operation)
    const rejected=expect(result).rejects.toThrow('rejected')
    expect(await h.step(async()=>({kind:'reject'}))).toEqual({kind:'reject'}); await rejected;expect(operation).not.toHaveBeenCalled()
  })
  it('removes queued work on cancellation and rejects without cancelling the agent',async()=>{
    const h=harness();const abort=new AbortController();const result=h.runner.run(h.agent,abort.signal,async()=>1);const rejected=expect(result).rejects.toThrow();abort.abort();await rejected;expect(h.queued).toHaveLength(0)
  })
  it('aborts an in-flight operation and drains its handler',async()=>{
    const h=harness();const abort=new AbortController();let operationSignal:AbortSignal|undefined;let release!:()=>void
    const result=h.runner.run(h.agent,abort.signal,async signal=>{operationSignal=signal;await new Promise<void>(r=>{release=r});signal.throwIfAborted();return 1})
    const rejected=expect(result).rejects.toThrow();const step=h.step();await vi.waitFor(()=>expect(operationSignal).toBeDefined());abort.abort();expect(operationSignal?.aborted).toBe(true);release();expect(await step).toEqual({kind:'enter',messages:[]});await rejected
  })
  it('disposes pending work and refuses new work',async()=>{
    const h=harness();const result=h.runner.run(h.agent,new AbortController().signal,async()=>1);const rejected=expect(result).rejects.toThrow();h.runner.dispose();await rejected;expect(h.queued).toHaveLength(0);await expect(h.runner.run(h.agent,new AbortController().signal,async()=>1)).rejects.toThrow('disposed')
  })
  it('settles a driver failure before pre-step instead of leaving Remote pending',async()=>{
    const h=harness();const result=h.runner.run(h.agent,new AbortController().signal,async()=>1);const rejected=expect(result).rejects.toThrow();h.listeners.get('agent/status')!({agent:h.agent,status:'idle'});await rejected
  })
  it('rejects overlapping operation reservations', async () => {
    const h=harness();const abort=new AbortController();const first=h.runner.run(h.agent,abort.signal,async()=>1)
    const rejected=expect(first).rejects.toThrow();await expect(h.runner.run(h.agent,new AbortController().signal,async()=>2)).rejects.toThrow('idle');abort.abort();await rejected
  })
  it('uses server-minted message identity, never matching text', async () => {
    const h=harness();const abort=new AbortController();const operation=vi.fn(async()=>1)
    const result=h.runner.run(h.agent,abort.signal,operation);const rejected=expect(result).rejects.toThrow()
    const fake={...h.queued[0],id:'spoof'} as UserMessage
    const next=vi.fn(async()=>({kind:'enter',messages:[fake]}))
    await h.listeners.get('agent/pre-step')!({agent:h.agent,messages:[fake],step:1,signal:abort.signal},next)
    expect(operation).not.toHaveBeenCalled();expect(next).toHaveBeenCalledTimes(1);abort.abort();await rejected
  })
  it('preserves concurrent user input when completing a reserved operation',async()=>{
    const h=harness();const result=h.runner.run(h.agent,new AbortController().signal,async()=>1)
    const other={id:'other',role:'user',content:[],source:{kind:'user'}} as UserMessage;h.queued.push(other)
    expect(await h.step()).toEqual({kind:'enter',messages:[]});await expect(result).resolves.toBe(1);expect(h.queued).toEqual([other])
  })
  it('drains disposal while admission is pending without running the operation',async()=>{
    const h=harness();const operation=vi.fn(async()=>1);const result=h.runner.run(h.agent,new AbortController().signal,operation)
    const rejected=expect(result).rejects.toThrow('disposed');let release!:()=>void;const messages=[...h.queued]
    const step=h.step(async()=>{await new Promise<void>(r=>{release=r});return {kind:'enter',messages}})
    h.runner.dispose();release();expect(await step).toEqual({kind:'enter',messages:[]});await rejected;expect(operation).not.toHaveBeenCalled();expect(h.listeners.size).toBe(0)
  })
  it('reports operation failure and releases the reservation',async()=>{
    const h=harness();const result=h.runner.run(h.agent,new AbortController().signal,async()=>{throw new Error('domain failed')})
    const rejected=expect(result).rejects.toThrow('domain failed');expect(await h.step()).toEqual({kind:'enter',messages:[]});await rejected
    h.agent.status='idle';const second=h.runner.run(h.agent,new AbortController().signal,async()=>2);await h.step();await expect(second).resolves.toBe(2)
  })

  it('does not start a model for gate-generated context after reservation removal',async()=>{
    const h=harness();const result=h.runner.run(h.agent,new AbortController().signal,async()=>1);const rejected=expect(result).rejects.toThrow()
    const context={id:'context',role:'user',content:[],source:{kind:'user'}} as UserMessage
    expect(await h.step(async()=>({kind:'enter',messages:[context]}))).toEqual({kind:'enter',messages:[]});await rejected
  })

})
