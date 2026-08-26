/**
 * Production assembly for the standalone dsh-md2wechat plugin.
 * @module @geekjourneyx/dsh-md2wechat
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CliEnvelope } from './cli/protocol.ts'
import { createCliGateway } from './cli/gateway.ts'
import { resolveConfig } from './config.ts'
import type { Config as PluginConfig } from './config.ts'
import { createDraftTool } from './tools/create-draft.ts'
import { createDoctorTool } from './tools/doctor.ts'
import { createExportTool } from './tools/export.ts'
import { createGenerateImagesTool } from './tools/generate-images.ts'
import { createImproveArticleTool } from './tools/improve-article.ts'
import { createPlanImagesTool } from './tools/plan-images.ts'
import { createPreviewTool } from './tools/preview.ts'
import { createStartArticleTool } from './tools/start-article.ts'
import { ArtifactStore } from './workspace/artifact-store.ts'
import { DraftStateStore } from './workspace/draft.ts'
import { ImagePlanStateStore } from './workspace/image-plan-state.ts'

export { Config } from './config.ts'

/** Cordis plugin name used in lifecycle diagnostics. */
export const name = 'dsh-md2wechat'

/** DSH services required before the plugin can activate. */
export const inject = ['tools', 'subprocess', 'fs', 'approval', 'credentials', 'jobs', 'systemPrompt'] as const

const SAFE_AUDIT_MESSAGES = new Set([
  'article preview operation history could not be recorded',
  'WeChat draft operation history could not be recorded',
  'md2wechat image audit record failed after committed result',
])

const FALLBACK_AUDIT_MESSAGE = 'md2wechat audit record could not be written'

/**
 * Validate the external CLI, assemble all configured tools, and register one workflow prompt.
 * @param ctx - Cordis context carrying the injected DSH services.
 * @param input - Host configuration with an absolute external CLI path.
 * @returns completion after fail-loud activation and lifecycle-owned registration.
 */
export async function apply(ctx: Context, input: PluginConfig): Promise<void> {
  const config = resolveConfig(input)
  const workspace = process.cwd()
  const gateway = createCliGateway(ctx, config)
  const store = new ArtifactStore(ctx.fs, workspace, config.artifactsDir)
  const imagePlanState = new ImagePlanStateStore(config.stateDir)
  const draftState = new DraftStateStore(config.stateDir)
  const reportAuditFailure = createAuditReporter(ctx)

  const activation = new AbortController()
  ctx.on('internal/plugin', (fiber) => {
    if (fiber === ctx.fiber && fiber.uid === null) {
      activation.abort(new Error('md2wechat plugin activation cancelled'))
    }
  })
  ctx.effect(
    () => () => activation.abort(new Error('md2wechat plugin activation cancelled')),
    'dsh-md2wechat: activation cancellation',
  )

  assertReadyProbe('version', await gateway.run(['version', '--json'], { signal: activation.signal }))
  assertReadyProbe('capabilities', await gateway.run(['capabilities', '--json'], { signal: activation.signal }))
  activation.signal.throwIfAborted()

  const previewDependencies = {
    store,
    layoutBaseUrl: config.layoutBaseUrl,
    credentialRefs: config.credentialRefs,
    credentials: ctx.credentials,
    approval: ctx.approval,
    previewTheme: config.previewTheme,
    previewFontSize: config.previewFontSize,
    previewBackgroundType: config.previewBackgroundType,
  }

  const tools = [
    createDoctorTool({ gateway }),
    createStartArticleTool({ fs: ctx.fs, workspace, store }),
    createImproveArticleTool({ gateway, store }),
    createPlanImagesTool({ gateway, store, state: imagePlanState }),
    createPreviewTool({ gateway, ...previewDependencies, reportAuditFailure }),
    createExportTool(previewDependencies),
  ]

  if (config.enableWechatWriteTools) {
    tools.push(createDraftTool({
      gateway,
      ...previewDependencies,
      state: draftState,
      imagePlanState,
      reportAuditFailure,
    }))
    if (config.enableFallbackImageTool) {
      tools.push(createGenerateImagesTool({
        gateway,
        store,
        state: imagePlanState,
        credentialRefs: config.credentialRefs,
        credentials: ctx.credentials,
        approval: ctx.approval,
        jobs: ctx.jobs,
        imageJobTimeoutMs: config.imageJobTimeoutMs,
        imageMaxBytes: config.imageMaxBytes,
        imageMaxRedirects: config.imageMaxRedirects,
        imageAcquisitionTimeoutMs: config.imageAcquisitionTimeoutMs,
        reportAuditFailure,
      }))
    }
  }

  for (const tool of tools) ctx.tools.register(tool)
  ctx.systemPrompt.section({
    name: 'tool:md2wechat',
    order: 120,
    text: workflowPrompt(config.enableWechatWriteTools, config.enableFallbackImageTool),
  })
}

function assertReadyProbe(name: 'version' | 'capabilities', response: CliEnvelope): void {
  const hasNextAction = response.next_actions !== undefined && response.next_actions.length > 0
  if (!response.success || response.status !== 'completed' || response.retryable
    || response.error !== undefined || response.error_details !== undefined || hasNextAction) {
    throw new Error(`md2wechat ${name} probe did not report ready`)
  }
}

function workflowPrompt(writeEnabled: boolean, fallbackEnabled: boolean): string {
  const workflow = writeEnabled
    ? 'Use this order: md2wechat_start_article or md2wechat_improve_article -> md2wechat_plan_images -> md2wechat_preview -> md2wechat_export or md2wechat_create_draft.'
    : 'Use this order: md2wechat_start_article or md2wechat_improve_article -> md2wechat_plan_images -> md2wechat_preview -> md2wechat_export.'
  const lines = [
    workflow,
    'Treat the signed preview as the source of truth for review and approval.',
  ]
  if (writeEnabled) {
    lines.push('md2wechat_create_draft creates an unpublished WeChat draft and never publishes or mass-sends.')
    if (fallbackEnabled) {
      lines.push('Use md2wechat_generate_images only when image work is required and the current DSH agent has no other image-generation capability.')
    }
  }
  return lines.join('\n')
}

function createAuditReporter(ctx: Context): (message: string) => void {
  return (message): void => {
    const safeMessage = SAFE_AUDIT_MESSAGES.has(message) ? message : FALLBACK_AUDIT_MESSAGE
    try {
      if (typeof ctx.logger?.warn === 'function') {
        ctx.logger.warn(safeMessage)
        return
      }
    } catch {
      // The process warning below is the bounded fallback for an unavailable host logger.
    }
    try {
      process.emitWarning(safeMessage, { code: 'DSH_MD2WECHAT_AUDIT' })
    } catch {
      // Audit reporting must not revoke an already committed operation.
    }
  }
}
