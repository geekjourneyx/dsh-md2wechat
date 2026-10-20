import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Official retained agents, never a replacement identity when restoration fails. */
export async function retainFixtureAgents(ctx, saved, workspace) {
  const handles = {};
  const setup = scope => ctx.agentPresets.mount(scope).then(() => undefined);
  try {
    for (const name of saved ? Object.keys(saved) : ['primary', 'panel']) {
      const agentOptions = { provider: 'creator-fixture', model: 'fixture' };
      handles[name] = saved
        ? await ctx.agents.resume({ resumeSessionId: saved[name], agentOptions, setup })
        : await ctx.agents.create({ sessionId: randomUUID(), agentOptions, meta: { cwd: workspace }, setup });
    }
    return handles;
  } catch (error) {
    await Promise.all(Object.values(handles).map(handle => handle.dispose?.()));
    throw error;
  }
}

/** Historical fixture only. The primary tool call is always produced by the real Agent loop. */
export function historicalCardSeed(events, staleArticleId) {
  let count = 0;
  const seed = structuredClone(events);
  for (const event of seed) {
    if (event.type === 'tool/result' && event.data.meta?.kind === 'md2wechat-creator') {
      event.data.meta.articleId = staleArticleId;
      count++;
    }
  }
  assert.ok(count, 'historical fixture requires a genuine creator result');
  return seed;
}

export function assertRestoredArticle(saved, restored) {
  for (const field of ['articleId', 'markdown', 'theme', 'coverId', 'imageCandidates', 'canUndo']) {
    assert.deepEqual(restored[field], saved[field], `restored ${field} changed`);
  }
  assert.equal(restored.reviewed, false, 'historical review was restored');
  assert.notEqual(restored.suggestionRequest?.status, 'pending', 'suggestion request was replayed');
  assert.notEqual(restored.imageRequest?.status, 'pending', 'image request was replayed');
}

export function assertNoAutomaticEffects(before, after) {
  for (const field of ['modelRequests', 'rendererRequests', 'simulatedWrites']) {
    assert.equal(after[field], before[field], `restoration caused ${field}`);
  }
}

export function assertReadOnlyAccess(results, articleId) {
  assert.equal(results.list.ok, true, 'read-only policy unexpectedly denied article listing');
  assert.ok(results.list.value.some(item => item.articleId === articleId), 'read-only list omitted the saved article');
  for (const method of ['get', 'resume']) {
    assert.equal(results[method].ok, true, `read-only policy unexpectedly denied ${method}`);
    assert.equal(results[method].value.articleId, articleId);
  }
  assert.equal(results.mutation.ok, false, 'read-only policy accepted a mutation');
}

export function assertPendingSuggestion(view) {
  assert.equal(view.suggestionRequest?.status, 'pending', 'restart requires an actual pending suggestion request');
  assert.ok(view.suggestionRequest.id, 'pending suggestion has no request identity');
}

/** Keep the offline fixture request genuinely in flight, but obey host shutdown cancellation. */
export async function waitForFixtureCancellation(signal) {
  assert.ok(signal, 'held fixture model request requires host cancellation');
  signal.throwIfAborted();
  await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
}
