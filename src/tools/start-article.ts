import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { domainResult, genericCall, genericResult } from './shared.ts'
import { computeArticleRevision } from '../workspace/revision.ts'
import type { ArticleManifest } from '../workspace/revision.ts'
import type { ArtifactStore } from '../workspace/artifact-store.ts'

const MAX_SOURCE_BYTES = 8 * 1024 * 1024

interface StartArticleToolDependencies {
  fs: Context['fs']
  workspace: string
  store: ArtifactStore
  now?: () => Date
}

/**
 * Create the immutable article-workspace initialization tool.
 * @param dependencies - Session filesystem, workspace, artifact store, and clock.
 * @returns Registry-ready typed DSH tool.
 */
export function createStartArticleTool({
  fs,
  workspace,
  store,
  now = () => new Date(),
}: StartArticleToolDependencies) {
  return defineTool({
    name: 'md2wechat_start_article',
    description: 'Copy a Markdown source into a new immutable md2wechat article revision without changing the source.',
    parameters: {
      sourcePath: { type: 'string', required: true, description: 'Markdown source inside the current session workspace.' },
      title: { type: 'string', description: 'Optional article title recorded in the revision manifest.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          revisionId: { type: 'string', required: true },
          articlePath: { type: 'string', required: true },
          manifestPath: { type: 'string', required: true },
          articleSha256: { type: 'string', required: true },
          title: { type: 'string' },
          locations: { type: 'array', required: true, items: { type: 'string' } },
          pluginVersion: { type: 'string', const: '1.0.0', required: true },
          cliVersion: { type: 'string', const: '3.3.0', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Article revision ${value.revisionId} is ready at ${value.articlePath}; use ${value.manifestPath} for later md2wechat tools.`,
      }],
    },
    async execute(args, exec) {
      assertKnownArguments(args, ['sourcePath', 'title'])
      const source = await resolveSource(fs, workspace, args.sourcePath, exec.signal)
      const bytes = await fs.readBytes(source.target, exec.signal, MAX_SOURCE_BYTES)
      const manifest: ArticleManifest = {
        schemaVersion: 1,
        articlePath: 'article.md',
        manifestPath: 'manifest.json',
        createdAt: now().toISOString(),
        ...(args.title === undefined ? {} : { title: args.title }),
      }
      const revision = computeArticleRevision(bytes, manifest)
      const articlePath = `revisions/${revision.id}/article.md`
      const manifestPath = `revisions/${revision.id}/manifest.json`
      await writeIdenticalOrNew(store, articlePath, bytes, exec.signal)
      await assertSourceUnchanged(fs, workspace, args.sourcePath, source, bytes, exec.signal)
      await writeIdenticalOrNew(store, manifestPath, encodeJson(manifest), exec.signal)
      const locations = [articlePath, manifestPath]
      return domainResult({
        revisionId: revision.id,
        articlePath,
        manifestPath,
        articleSha256: revision.articleSha256,
        ...(manifest.title === undefined ? {} : { title: manifest.title }),
        locations,
      })
    },
    presentCall: args => genericCall('Start md2wechat article', 'edit', args.sourcePath, [args.sourcePath]),
    presentResult: () => genericResult('Article workspace ready'),
  })
}

interface SourceSnapshot {
  target: Awaited<ReturnType<Context['fs']['resolve']>>
  version: string
}

async function resolveSource(
  fs: Context['fs'],
  workspace: string,
  sourcePath: string,
  signal: AbortSignal,
): Promise<SourceSnapshot> {
  const root = await fs.resolve(workspace, { signal })
  const target = await fs.resolve(sourcePath, { cwd: workspace, signal })
  if (!fs.contains(root, target)) throw new Error('article source must stay inside the session workspace')
  const info = await fs.stat(target, signal)
  if (info === undefined) throw new Error('article source does not exist')
  if (info.type !== 'file') throw new Error('article source must be a regular file')
  if (info.size !== undefined && info.size > MAX_SOURCE_BYTES) throw new Error('article source exceeds the 8-MiB limit')
  return { target, version: String(info.version) }
}

async function assertSourceUnchanged(
  fs: Context['fs'],
  workspace: string,
  sourcePath: string,
  before: SourceSnapshot,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  const current = await resolveSource(fs, workspace, sourcePath, signal)
  const currentBytes = await fs.readBytes(current.target, signal, MAX_SOURCE_BYTES)
  if (current.target.targetKey !== before.target.targetKey
    || current.version !== before.version
    || sha256(currentBytes) !== sha256(bytes)) {
    throw new Error('article source changed while the revision was being created')
  }
}

async function writeIdenticalOrNew(
  store: ArtifactStore,
  path: string,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  try {
    const existing = await store.read(path, signal)
    if (sha256(existing) !== sha256(bytes)) throw new Error('existing immutable revision content conflicts with the computed revision')
    return
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  await store.writeAtomic(path, bytes, signal)
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`)
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'FS_NOT_FOUND'
}

function assertKnownArguments(args: object, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new Error(`unknown start-article argument ${key}`)
  }
}
