import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { CliGateway } from '../cli/gateway.ts'
import { domainResult, genericCall, genericResult } from './shared.ts'
import type { ArtifactStore } from '../workspace/artifact-store.ts'
import {
  appendOperation,
  computeArticleRevision,
  validateRevisionManifest,
} from '../workspace/revision.ts'
import type { ArticleManifest, ArticleRevision } from '../workspace/revision.ts'

const manifestPattern = /^revisions\/([a-f0-9]{64})\/manifest\.json$/u

interface ImproveArticleToolDependencies {
  gateway: CliGateway
  store: ArtifactStore
  now?: () => Date
}

/** Loaded immutable revision with canonical artifact and process paths. */
export interface CurrentArticleRevision {
  revision: ArticleRevision
  manifest: ArticleManifest
  manifestPath: string
  articlePath: string
  articleProcessPath: string
  articleBytes: Uint8Array
}

/**
 * Load and authenticate an exact immutable revision manifest before CLI use.
 * @param store - Contained artifact store.
 * @param manifestPath - Full artifact-relative revision manifest path.
 * @param signal - Optional cancellation signal.
 * @returns Current manifest, article bytes, revision, and authorized CLI input path.
 */
export async function loadCurrentArticleRevision(
  store: ArtifactStore,
  manifestPath: string,
  signal?: AbortSignal,
): Promise<CurrentArticleRevision> {
  const match = manifestPattern.exec(manifestPath)
  if (match === null) throw new Error('manifestPath must match revisions/<revision-id>/manifest.json')
  const directoryId = match[1]!
  const manifest = parseManifest(await store.read(manifestPath, signal))
  if (manifest.articlePath !== 'article.md' || manifest.manifestPath !== 'manifest.json') {
    throw new Error('revision manifest must use revision-local article.md and manifest.json paths')
  }
  const articlePath = `revisions/${directoryId}/article.md`
  const articleBytes = await store.read(articlePath, signal)
  const revision = computeArticleRevision(articleBytes, manifest)
  if (revision.id !== directoryId) throw new Error('stale revision: manifest, article, or directory identity does not match')
  const articleProcessPath = await store.processPathForRead(articlePath, signal)
  return { revision, manifest, manifestPath, articlePath, articleProcessPath, articleBytes }
}

/**
 * Create the side-effect-free article improvement request tool.
 * @param dependencies - CLI gateway, artifact store, and operation clock.
 * @returns Registry-ready typed DSH tool.
 */
export function createImproveArticleTool({
  gateway,
  store,
  now = () => new Date(),
}: ImproveArticleToolDependencies) {
  return defineTool({
    name: 'md2wechat_improve_article',
    description: 'Prepare advice or an AI rewrite request for the current immutable article; never changes article bytes.',
    parameters: {
      manifestPath: { type: 'string', required: true, description: 'Manifest path returned by md2wechat_start_article.' },
      operation: {
        type: 'string', required: true, enum: ['advise', 'title', 'humanize', 'writer_style'],
        description: 'Improvement request to prepare for the current DSH Agent.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          revisionId: { type: 'string', required: true },
          manifestPath: { type: 'string', required: true },
          articlePath: { type: 'string', required: true },
          operation: { type: 'string', required: true, enum: ['advise', 'title', 'humanize', 'writer_style'] },
          cliCode: { type: 'string', required: true },
          preparedRequest: { type: 'json', required: true },
          recordPath: { type: 'string', required: true },
          locations: { type: 'array', required: true, items: { type: 'string' } },
          pluginVersion: { type: 'string', const: '1.0.0', required: true },
          cliVersion: { type: 'string', const: '3.3.0', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Prepared ${value.operation} request for the current DSH Agent:\n${JSON.stringify(value.preparedRequest)}`,
      }],
    },
    async execute(args, exec) {
      assertKnownArguments(args, ['manifestPath', 'operation'])
      const current = await loadCurrentArticleRevision(store, args.manifestPath, exec.signal)
      const argv = improvementArgv(args.operation, current.articleProcessPath)
      const response = await gateway.run(argv, { signal: exec.signal })
      if (!response.success || response.status === 'failed') throw new Error(`md2wechat ${args.operation} preparation failed with ${response.code}`)
      const verified = await loadCurrentArticleRevision(store, args.manifestPath, exec.signal)
      if (verified.revision.articleSha256 !== current.revision.articleSha256) {
        throw new Error('stale revision: article changed while preparing the request')
      }
      const recordPath = `revisions/${current.revision.id}/operations.jsonl`
      const preparedRequest = (response.data ?? {}) as JsonValue
      await appendOperation(store, current.revision, {
        operation: args.operation,
        createdAt: now().toISOString(),
        details: { cliCode: response.code, preparedRequest },
      }, [])
      return domainResult({
        revisionId: current.revision.id,
        manifestPath: current.manifestPath,
        articlePath: current.articlePath,
        operation: args.operation,
        cliCode: response.code,
        preparedRequest,
        recordPath,
        locations: [current.articlePath, current.manifestPath, recordPath],
      })
    },
    presentCall: args => genericCall('Prepare article improvement', 'read', args.operation, revisionLocations(args.manifestPath)),
    presentResult: () => genericResult('Article improvement prepared'),
  })
}

function improvementArgv(
  operation: 'advise' | 'title' | 'humanize' | 'writer_style',
  article: string,
): readonly string[] {
  switch (operation) {
    case 'advise': return ['advise', article, '--json']
    case 'title': return ['title', 'suggest', article, '--json']
    case 'humanize': return ['humanize', article, '--json']
    case 'writer_style': return ['write', article, '--input-type', 'fragment', '--json']
    default: return assertNever(operation)
  }
}

function parseManifest(bytes: Uint8Array): ArticleManifest {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (error) {
    throw new Error('revision manifest must contain valid UTF-8 JSON', { cause: error })
  }
  return validateRevisionManifest(value)
}

function assertNever(value: never): never {
  throw new Error(`unsupported improvement operation ${String(value)}`)
}

function assertKnownArguments(args: object, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new Error(`unknown improve-article argument ${key}`)
  }
}

function revisionLocations(manifestPath: string): readonly string[] {
  const revisionId = manifestPattern.exec(manifestPath)?.[1]
  if (revisionId === undefined) return [manifestPath]
  return [
    manifestPath,
    `revisions/${revisionId}/article.md`,
    `revisions/${revisionId}/operations.jsonl`,
  ]
}
