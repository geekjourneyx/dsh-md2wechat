import type { Context } from '@deepseek-ai/cordis'
import type { OperationTurnRunner } from './operation-turn.ts'

/** Only the host's approval audit needs a turn; CLI work runs in the caller afterwards. */
export function createUiApproval(approval: Pick<Context['approval'], 'request'>, turns: OperationTurnRunner): Pick<Context['approval'], 'request'> {
  return {
    request(request) {
      const signal = request.signal ?? new AbortController().signal
      return turns.run(request.agent, signal, approvalSignal => approval.request({ ...request, signal: approvalSignal }))
    },
  }
}
