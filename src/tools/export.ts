import { probeCliVersion } from '../cli/gateway.ts'
import type { CliGateway } from '../cli/gateway.ts'
import { PLUGIN_VERSION } from '../version.ts'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { OperationCredentialServices } from '../security/credentials.ts'
import { resolveOperationEnv } from '../security/credentials.ts'
import type { ArtifactStore } from '../workspace/artifact-store.ts'
import { preflightCurrentPreview, validateCurrentPreview } from '../workspace/preview.ts'
import { preparePreviewInputs, previewSnapshotInputFor } from './preview.ts'
import { domainResult, genericCall, genericResult } from './shared.ts'

const TOOL_NAME = 'md2wechat_export'

/** Dependencies required to export exact signed preview bytes. */
export interface ExportToolDependencies {
  gateway?: CliGateway
  store: ArtifactStore
  layoutBaseUrl: string
  credentialRefs: OperationCredentialServices['credentialRefs']
  credentials: OperationCredentialServices['credentials']
  approval: Pick<Context['approval'], 'request'>
  previewTheme: string
  previewFontSize: 'small' | 'medium' | 'large'
  previewBackgroundType: 'default' | 'grid' | 'none'
  now?: () => Date
}

/** Shared domain operation; callers provide real approval-turn context, never a synthetic tool token. */
export function createExportOperation(dependencies: ExportToolDependencies) {
  return async (args: { manifestPath: string; previewReceiptId: string; destinationPath: string }, exec: Pick<ToolRunContext, 'agent' | 'callId' | 'signal'>) => {
      try {
        assertExactArgs(args, ['manifestPath', 'previewReceiptId', 'destinationPath'])
        if (typeof args.destinationPath !== 'string' || !isAbsolute(args.destinationPath)) throw new SafeExportError('export destination must be an absolute path')
        if (args.destinationPath.length > 4096 || containsControl(args.destinationPath)) throw new SafeExportError('export destination is outside safe bounds')
        exec.signal.throwIfAborted()
        const before = await preparePreviewInputs(dependencies.store, args.manifestPath, exec.signal)
        const clock = (dependencies.now ?? (() => new Date()))()
        const structural = await preflightCurrentPreview(dependencies.store, before.current.revision.id, args.previewReceiptId, clock, exec.signal)
        const exportAuthorization = await dependencies.store.authorizeCopyOut(structural.htmlPath, structural.receipt.previewHtmlSha256, args.destinationPath, exec.signal)
        if (exec.agent === undefined) throw new SafeExportError('preview export requires an active agent')
        const outcome = await dependencies.approval.request({ agent: exec.agent, toolName: TOOL_NAME, callId: exec.callId, reason: `Write the current signed preview HTML locally to ${args.destinationPath}.`, signal: exec.signal })
        assertApproved(outcome)
        const reference = dependencies.credentialRefs.MD2WECHAT_API_KEY
        if (reference === undefined) throw new SafeExportError('MD2WECHAT_API_KEY is not configured for preview export')
        const resolved = await resolveOperationEnv(['MD2WECHAT_API_KEY'], dependencies)
        const value = resolved.env.MD2WECHAT_API_KEY
        if (value === undefined) throw new SafeExportError('MD2WECHAT_API_KEY is not configured for preview export')
        const current = await preparePreviewInputs(dependencies.store, args.manifestPath, exec.signal)
        if (current.contentId !== before.contentId) throw new SafeExportError('preview inputs changed after approval')
        const verified = await validateCurrentPreview(dependencies.store, {
          snapshotInput: previewSnapshotInputFor(current, dependencies.layoutBaseUrl, reference, value, dependencies.previewTheme, dependencies.previewFontSize, dependencies.previewBackgroundType, await probeCliVersion(dependencies.gateway, exec.signal)),
          credentialValue: value, now: (dependencies.now ?? (() => new Date()))(), signal: exec.signal,
        })
        if (verified.receipt.id !== args.previewReceiptId || verified.htmlPath !== exportAuthorization.sourceRelative || verified.receipt.previewHtmlSha256 !== exportAuthorization.expectedSha256) throw new SafeExportError('stale preview')
        await exportAuthorization.commitVerified(verified.htmlBytes, exec.signal)
        return domainResult({ manifestPath: current.current.manifestPath, revisionId: current.current.revision.id, previewReceiptId: verified.receipt.id, sourcePath: verified.htmlPath, destinationPath: args.destinationPath, sha256: createHash('sha256').update(verified.htmlBytes).digest('hex') }, verified.receipt.cliVersion)
      } catch (error) {
        if (exec.signal.aborted || error instanceof ExportCancelledError) throw new Error('preview export cancelled')
        if (error instanceof SafeExportError) throw new Error(error.message)
        throw new Error('preview export failed')
      }
  }
}

/**
 * Create the exact-current-preview export tool.
 * @param dependencies - Storage, preview configuration, credentials, approval, and clock.
 * @returns Registry-ready typed DSH tool.
 */
export function createExportTool(dependencies: ExportToolDependencies) {
  const operation = createExportOperation(dependencies)
  return defineTool({
    name: TOOL_NAME,
    description: 'Export the exact current signed md2wechat preview HTML to one explicit local destination.',
    parameters: {
      manifestPath: { type: 'string', required: true },
      previewReceiptId: { type: 'string', required: true },
      destinationPath: { type: 'string', required: true },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      manifestPath: { type: 'string', required: true }, revisionId: { type: 'string', required: true }, previewReceiptId: { type: 'string', required: true }, sourcePath: { type: 'string', required: true }, destinationPath: { type: 'string', required: true }, sha256: { type: 'string', required: true }, pluginVersion: { type: 'string', const: PLUGIN_VERSION, required: true }, cliVersion: { type: 'string', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: `Signed preview exported to ${value.destinationPath}.` }] },
    execute: operation,
    presentCall: args => genericCall('Export signed md2wechat preview', 'edit', safeDestination(args.destinationPath), safeExportLocations(args.manifestPath, args.destinationPath)),
    presentResult: () => genericResult('Signed preview exported'),
  })
}

class SafeExportError extends Error {}
class ExportCancelledError extends Error {}
function assertExactArgs(value: object, keys: readonly string[]): void { const expected = new Set(keys); if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !expected.has(key))) throw new SafeExportError('preview export contains unknown or missing arguments') }
function assertApproved(value: ApprovalOutcome): void { if (value === 'allowed-once') return; if (value === 'cancelled') throw new ExportCancelledError(); throw new SafeExportError(`preview export approval ${value}`) }
function containsControl(value: string): boolean { return [...value].some(character => character.codePointAt(0)! <= 0x1f || character.codePointAt(0) === 0x7f) }
function safeDestination(value: string): string | undefined { return typeof value === 'string' && value.length <= 4096 && !containsControl(value) && isAbsolute(value) ? value : undefined }
function safeExportLocations(manifestPath: string, destinationPath: string): readonly string[] { const values: string[] = []; if (typeof manifestPath === 'string' && /^revisions\/[a-f0-9]{64}\/manifest\.json$/u.test(manifestPath)) values.push(manifestPath); const destination = safeDestination(destinationPath); if (destination !== undefined) values.push(destination); return values }
