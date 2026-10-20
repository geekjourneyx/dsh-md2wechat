import { describe, expect, it, vi } from 'vitest'
import {
  assertNoAutomaticEffects,
  assertPendingSuggestion,
  assertReadOnlyAccess,
  assertRestoredArticle,
  historicalCardSeed,
  retainFixtureAgents,
  waitForFixtureCancellation,
} from '../../scripts/creator-host-acceptance/support.mjs'

describe('installed creator acceptance support', () => {
  it('resumes exact persisted sessions without creating replacements or requesting model work', async () => {
    const resume = vi.fn(async ({ resumeSessionId }) => ({ agent: { id: resumeSessionId } }))
    const create = vi.fn()
    const ctx = { agents: { resume, create }, agentPresets: { mount: vi.fn() } }
    const result = await retainFixtureAgents(ctx, { primary: 'primary-id', panel: 'panel-id', legacy: 'legacy-id' }, '/fixture')
    expect(result.primary.agent.id).toBe('primary-id')
    expect(result.panel.agent.id).toBe('panel-id')
    expect(result.legacy.agent.id).toBe('legacy-id')
    expect(resume.mock.calls.map(([options]) => options.resumeSessionId)).toEqual(['primary-id', 'panel-id', 'legacy-id'])
    expect(create).not.toHaveBeenCalled()
  })

  it('fails closed on a persisted session resume error instead of creating a new session', async () => {
    const create = vi.fn()
    const ctx = { agents: { resume: vi.fn(async () => { throw new Error('missing persisted session') }), create }, agentPresets: {} }
    await expect(retainFixtureAgents(ctx, { primary: 'old-id', panel: 'panel-id' }, '/fixture')).rejects.toThrow('missing persisted session')
    expect(create).not.toHaveBeenCalled()
  })

  it('creates separate fresh sessions without sending a message to the panel session', async () => {
    let count = 0
    const create = vi.fn(async options => ({ agent: { id: options.sessionId, followup: vi.fn() }, number: ++count }))
    const ctx = { agents: { create }, agentPresets: { mount: vi.fn() } }
    const result = await retainFixtureAgents(ctx, null, '/fixture')
    expect(result.primary.agent.id).not.toBe(result.panel.agent.id)
    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls.every(([options]) => options.meta.cwd === '/fixture')).toBe(true)
    expect(result.panel.agent.followup).not.toHaveBeenCalled()
  })

  it('copies genuine fixture history only for an explicitly labelled stale-card fixture', () => {
    const events = [
      { seq: 0, type: 'tool/call', data: { name: 'md2wechat_open_workspace', arguments: '{}' } },
      { seq: 1, type: 'tool/result', data: { meta: { kind: 'md2wechat-creator', schemaVersion: 1, articleId: 'current-id' }, content: 'fixture' } },
    ]
    const seed = historicalCardSeed(events, 'obsolete-random-id')
    expect(seed[1].data.meta.articleId).toBe('obsolete-random-id')
    expect(events[1].data.meta?.articleId).toBe('current-id')
    expect(seed[0]).toEqual(events[0])
    expect(() => historicalCardSeed([], 'old-id')).toThrow('creator result')
  })

  it('checks the saved article content and refuses restored approval or pending requests', () => {
    const saved = { articleId: 'article', markdown: '# Saved', theme: 'simple', coverId: 'cover', imageCandidates: [{ id: 'cover', sha256: 'hash' }], canUndo: true }
    const restored = { ...saved, reviewed: false, suggestionRequest: null, imageRequest: null }
    expect(() => assertRestoredArticle(saved, restored)).not.toThrow()
    expect(() => assertRestoredArticle(saved, { ...restored, articleId: 'replacement' })).toThrow()
    expect(() => assertRestoredArticle(saved, { ...restored, markdown: '# Overwritten' })).toThrow()
    expect(() => assertRestoredArticle(saved, { ...restored, reviewed: true })).toThrow()
    expect(() => assertRestoredArticle(saved, { ...restored, imageRequest: { status: 'pending' } })).toThrow()
  })

  it('does not mistake unchanged content for proof that restoration made no external calls', () => {
    const before = { modelRequests: 0, rendererRequests: 4, simulatedWrites: 2 }
    expect(() => assertNoAutomaticEffects(before, { ...before })).not.toThrow()
    for (const field of Object.keys(before)) {
      expect(() => assertNoAutomaticEffects(before, { ...before, [field]: before[field] + 1 })).toThrow()
    }
  })

  it('requires read-only access to preserve article reads but refuse mutation', () => {
    const results = {
      list: { ok: true, value: [{ articleId: 'article' }] },
      get: { ok: true, value: { articleId: 'article' } },
      resume: { ok: true, value: { articleId: 'article' } },
      mutation: { ok: false },
    }
    expect(() => assertReadOnlyAccess(results, 'article')).not.toThrow()
    expect(() => assertReadOnlyAccess({ ...results, get: { ok: false } }, 'article')).toThrow()
    expect(() => assertReadOnlyAccess({ ...results, mutation: { ok: true } }, 'article')).toThrow()
  })

  it('rejects a vacuous pending-request restart precondition', () => {
    expect(() => assertPendingSuggestion({ suggestionRequest: null })).toThrow()
    expect(() => assertPendingSuggestion({ suggestionRequest: { id: 'request', status: 'ready' } })).toThrow()
    expect(() => assertPendingSuggestion({ suggestionRequest: { id: 'request', status: 'pending' } })).not.toThrow()
  })

  it('holds fixture model output pending until the real host cancels it', async () => {
    const controller = new AbortController()
    let settled = false
    const pending = waitForFixtureCancellation(controller.signal)
    const outcome = pending.catch(error => { settled = true; return error })
    await Promise.resolve()
    expect(settled).toBe(false)
    controller.abort(new Error('host stopped'))
    expect(await outcome).toMatchObject({ message: 'host stopped' })
  })
})
