import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CreatorService } from './service.ts'

/** One creator-facing entry instead of asking the author to orchestrate tools. */
export function createOpenWorkspaceTool(service: CreatorService) {
  return defineTool({
    name: 'md2wechat_open_workspace',
    description: 'Show an article card in the current conversation so the author can preview, adjust and save a WeChat draft. Pass markdown for text just written in chat, or sourcePath for an existing workspace file. Never ask the author to type a path.',
    parameters: {
      markdown: { type: 'string', description: 'Full Markdown article composed in this conversation. Use instead of sourcePath for a new article.' },
      sourcePath: { type: 'string', description: 'Markdown source inside this session workspace.' },
      title: { type: 'string', description: 'Optional article title.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        articleId: { type: 'string', required: true }, title: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: `「${value.title}」已准备好。点开文章卡片，查看效果、调整标题与配图，最后保存到公众号草稿箱。` }],
      presentationMeta: (_args, value) => ({ kind: 'md2wechat-creator', schemaVersion: 1, articleId: value.articleId }),
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('请在文章所属的会话中打开工作区。')
      if (!args.markdown && !args.sourcePath) throw new Error('请提供文章正文。')
      const view = args.markdown ? await service.importSource(exec.agent, { name: args.title || '文章', markdown: args.markdown }, exec.signal) : await service.open(exec.agent, args.sourcePath!, args.title ?? '', exec.signal)
      return { articleId: view.articleId, title: view.title }
    },
  })
}

/** Agent proposals never apply edits; only an explicit native-workspace action does. */
export function createProposeChangesTool(service: CreatorService) {
  return defineTool({
    name: 'md2wechat_propose_changes',
    description: 'Return at most 3 exact before/after article suggestions for a pending creator workspace request. Does not edit or publish anything.',
    parameters: {
      articleId: { type: 'string', required: true },
      version: { type: 'number', required: true },
      requestId: { type: 'string', required: true },
      changes: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        title: { type: 'string', required: true }, reason: { type: 'string', required: true },
        before: { type: 'string', required: true }, after: { type: 'string', required: true },
      } } },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { accepted: { type: 'boolean', required: true } } }, render: () => [{ type: 'text', text: '建议已显示在文章工作区，等待用户决定。未修改文章。' }] },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('建议必须来自文章所属会话。')
      exec.signal.throwIfAborted()
      await service.propose(exec.agent, args.articleId, args.version, args.requestId, args.changes, exec.signal)
      return { accepted: true }
    },
  })
}

export function createImportCreatorImageTool(service: CreatorService) {
  return defineTool({
    name: 'md2wechat_import_creator_image',
    description: 'Offer an actual local image as a candidate for the pending creator request. Never selects it, edits the article or uploads anything.',
    parameters: { articleId: { type: 'string', required: true }, version: { type: 'number', required: true }, requestId: { type: 'string', required: true }, sourcePath: { type: 'string', required: true }, alt: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { accepted: { type: 'boolean', required: true } } }, render: () => [{ type: 'text', text: '图片候选已显示在文章工作区，尚未选用或上传。' }] },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('请在文章所属会话中提供图片。')
      await service.importImage(exec.agent, args.articleId, args.version, args.requestId, args.sourcePath, args.alt, exec.signal)
      return { accepted: true }
    },
  })
}

export function createGenerateCreatorImagesTool(service: CreatorService) {
  return defineTool({
    name: 'md2wechat_generate_creator_images',
    description: 'Fallback only when the current host has no image capability: generate requested creator candidates AND upload every candidate to WeChat material storage. Requires explicit one-time approval; may incur provider costs. Wait for job completion before importing sourcePaths.',
    parameters: { articleId: { type: 'string', required: true }, version: { type: 'number', required: true }, requestId: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, enum: ['background', 'completed'] }, jobId: { type: 'string' }, sourcePaths: { type: 'array', required: true, items: { type: 'string' } } } }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('请在文章所属会话中生成图片。')
      const result = await service.generateImages(exec.agent, args.articleId, args.version, args.requestId, exec.signal)
      return { kind: result.kind, ...(result.jobId ? { jobId: result.jobId } : {}), sourcePaths: result.sourcePaths }
    },
  })
}
