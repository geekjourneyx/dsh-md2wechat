import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { creatorRemoteError } from './errors.ts'
import type { ArticleSummary, CreatorAction, CreatorOpenOptions, CreatorRevisionSummary, CreatorView } from './types.ts'

export interface CreatorBackend {
  discoverRevisions(agent: Agent, signal: AbortSignal): Promise<CreatorRevisionSummary[]>
  recoverRevision(agent: Agent, manifestPath: string, signal: AbortSignal): Promise<CreatorView>
  list(agent: Agent, signal: AbortSignal): Promise<ArticleSummary[]>
  open(agent: Agent, source: string, title: string, signal: AbortSignal, options?: CreatorOpenOptions): Promise<CreatorView>
  resume(agent: Agent, articleId: string, signal: AbortSignal): Promise<CreatorView>
  get(agent: Agent, articleId: string, signal?: AbortSignal): Promise<CreatorView>
  dispatch(agent: Agent, articleId: string, version: number, action: CreatorAction, signal: AbortSignal): Promise<CreatorView>
}
declare module '@deepseek-ai/cordis' { interface Context { md2wechat: CreatorRemote } }

/** Authenticated Agent lookup on every endpoint; UI state and saved records never grant authority. */
export class CreatorRemote extends TypertRemoteService {
  constructor(ctx: Context, private readonly backend?: CreatorBackend) { super(ctx, 'md2wechat', { namespace: 'md2wechat' }) }
  @Remote('session')
  async session(agent: Agent, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw creatorRemoteError(undefined, 'HOST_UNAVAILABLE')
    return agent.id
  }
  @Remote('list')
  async list(agent: Agent, signal: AbortSignal): Promise<ArticleSummary[]> {
    return this.invoke(signal, backend => backend.list(agent, signal))
  }
  @Remote('open')
  async open(agent: Agent, source: string, title: string, options: CreatorOpenOptions, signal: AbortSignal): Promise<CreatorView> {
    return this.invoke(signal, backend => backend.open(agent, source, title, signal, options))
  }
  @Remote('resume')
  async resume(agent: Agent, articleId: string, signal: AbortSignal): Promise<CreatorView> {
    return this.invoke(signal, backend => backend.resume(agent, articleId, signal))
  }
  @Remote('discoverRevisions')
  async discoverRevisions(agent: Agent, signal: AbortSignal): Promise<CreatorRevisionSummary[]> {
    return this.invoke(signal, backend => backend.discoverRevisions(agent, signal))
  }
  @Remote('recoverRevision')
  async recoverRevision(agent: Agent, manifestPath: string, signal: AbortSignal): Promise<CreatorView> {
    return this.invoke(signal, backend => backend.recoverRevision(agent, manifestPath, signal))
  }
  @Remote('get')
  async get(agent: Agent, articleId: string, signal: AbortSignal): Promise<CreatorView> {
    return this.invoke(signal, backend => backend.get(agent, articleId, signal))
  }
  @Remote('dispatch')
  async dispatch(agent: Agent, articleId: string, version: number, action: CreatorAction, signal: AbortSignal): Promise<CreatorView> {
    return this.invoke(signal, backend => backend.dispatch(agent, articleId, version, action, signal))
  }
  private async invoke<T>(signal: AbortSignal, operation: (backend: CreatorBackend) => Promise<T>): Promise<T> {
    try {
      signal.throwIfAborted()
      if (!this.backend) throw creatorRemoteError(undefined, 'HOST_UNAVAILABLE')
      // Retain all current-policy checks and deterministic operation turns in the real backend.
      const result = await operation(this.backend)
      signal.throwIfAborted()
      return result
    } catch (error) {
      if (signal.aborted) throw creatorRemoteError(undefined, 'HOST_UNAVAILABLE')
      throw creatorRemoteError(error)
    }
  }
}
