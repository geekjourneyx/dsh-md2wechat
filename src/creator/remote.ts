import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { CreatorAction, CreatorView } from './types.ts'

export interface CreatorBackend {
  get(agent: Agent, articleId: string): CreatorView
  dispatch(agent: Agent, articleId: string, version: number, action: CreatorAction, signal: AbortSignal): Promise<CreatorView>
}
declare module '@deepseek-ai/cordis' { interface Context { md2wechat: CreatorRemote } }

/** Authenticated session lookup; UI state never grants filesystem or account authority. */
export class CreatorRemote extends TypertRemoteService {
  constructor(ctx: Context, private readonly backend?: CreatorBackend) { super(ctx, 'md2wechat', { namespace: 'md2wechat' }) }
  @Remote('session')
  async session(agent: Agent, signal: AbortSignal): Promise<string> { signal.throwIfAborted(); return agent.id }
  @Remote('get')
  async get(agent: Agent, articleId: string, signal: AbortSignal): Promise<CreatorView> {
    signal.throwIfAborted()
    if (!this.backend) throw new Error('请重新打开文章工作区。')
    return this.backend.get(agent, articleId)
  }
  @Remote('dispatch')
  async dispatch(agent: Agent, articleId: string, version: number, action: CreatorAction, signal: AbortSignal): Promise<CreatorView> {
    if (!this.backend) throw new Error('请重新打开文章工作区。')
    return this.backend.dispatch(agent, articleId, version, action, signal)
  }
}
