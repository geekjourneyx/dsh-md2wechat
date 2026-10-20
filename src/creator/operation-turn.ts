import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

export interface OperationTurnRunner {
  run<T>(agent: Agent, signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T>
  dispose(): void
}

interface Pending {
  agent: Agent
  message: UserMessage
  controller: AbortController
  run(signal: AbortSignal): Promise<void>
  reject(error: unknown): void
  cleanup(): void
}

/** Run a reserved UI operation inside a driver-owned, model-free first turn. */
export function createOperationTurnRunner(ctx: Context): OperationTurnRunner {
  const pending = new Map<Agent, Pending>()
  let disposed = false
  let releaseListeners = (): void => {}
  const remove = (entry: Pending): void => {
    if (pending.get(entry.agent) !== entry) return
    pending.delete(entry.agent)
    entry.cleanup()
    if (disposed && pending.size === 0) releaseListeners()
  }
  const stop = (entry: Pending, error: Error): void => {
    entry.controller.abort(error)
    entry.reject(error)
    // Keep a claimed reservation until its hook drains, so it cannot leak to a model.
    if (entry.agent.inbox.remove(entry.message.id)) remove(entry)
  }
  const restore = (agent: Agent, messages: UserMessage[], own: UserMessage): void => {
    for (const message of messages.filter(value => value.id !== own.id).toReversed()) {
      if (![...agent.inbox.nextStep, ...agent.inbox.nextTurn].some(value => value.id === message.id)) {
        agent.inbox.prepend('next-step', message)
      }
    }
  }
  const offStep = ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next): Promise<PreStepDecision> => {
    const entry = pending.get(agent)
    if (entry === undefined || !messages.some(message => message.id === entry.message.id)) return next()
    try {
      const decision = await next()
      if (decision.kind === 'reject') {
        entry.reject(new Error('creator operation rejected by admission policy'))
        restore(agent, messages, entry.message)
        return decision
      }
      if (step !== 1 || !decision.messages.some(message => message.id === entry.message.id)) {
        entry.reject(new Error('creator operation reservation was not admitted'))
        restore(agent, messages, entry.message)
        return step === 1 ? { kind: 'enter', messages: [] } : { kind: 'reject' }
      }
      // The inbox claim can include steering that arrived after idle admission.
      // Preserve it for a later turn rather than running a model in this turn.
      restore(agent, messages, entry.message)
      const combined = AbortSignal.any([signal, entry.controller.signal])
      combined.throwIfAborted()
      await entry.run(combined)
      return { kind: 'enter', messages: [] }
    } catch (error) {
      entry.reject(error)
      restore(agent, messages, entry.message)
      return { kind: 'enter', messages: [] }
    } finally {
      remove(entry)
    }
  })
  const offStatus = ctx.on('agent/status', ({ agent, status }) => {
    const entry = pending.get(agent)
    if (status !== 'idle' || entry === undefined) return
    stop(entry, new Error('creator operation turn ended before completion'))
    remove(entry)
  })
  const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
    const entry = pending.get(agent)
    if (entry === undefined) return
    stop(entry, new Error('creator operation agent disposed'))
    remove(entry)
  })
  const runner: OperationTurnRunner = {
    async run<T>(agent: Agent, signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (disposed) throw new Error('creator operation runner disposed')
      signal.throwIfAborted()
      if (agent.status !== 'idle' || pending.has(agent) || agent.inbox.nextStep.length > 0 || agent.inbox.nextTurn.length > 0) {
        throw new Error('creator operation requires an idle agent with no pending input')
      }
      const message = createUserMessage({ content: [{ type: 'text', text: 'Run the requested creator action.' }], source: { kind: 'user' } })
      return new Promise<T>((resolve, reject) => {
        const controller = new AbortController()
        const abort = (): void => stop(entry, new Error('creator operation cancelled'))
        const entry: Pending = {
          agent, message, controller, reject,
          async run(operationSignal) { const value = await operation(operationSignal); operationSignal.throwIfAborted(); resolve(value) },
          cleanup() { signal.removeEventListener('abort', abort) },
        }
        pending.set(agent, entry)
        signal.addEventListener('abort', abort, { once: true })
        try { agent.followup(message) } catch (error) { remove(entry); agent.inbox.remove(message.id); reject(error) }
      })
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const entry of pending.values()) stop(entry, new Error('creator operation runner disposed'))
      // Active hooks retain their local entry and drain on the combined signal.
      if (pending.size === 0) releaseListeners()
    },
  }
  releaseListeners = () => { offStep(); offStatus(); offDisposed() }
  ctx.effect(() => () => runner.dispose(), 'md2wechat creator operation turns')
  return runner
}
