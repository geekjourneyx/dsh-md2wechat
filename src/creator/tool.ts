import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CreatorService } from './service.ts'

/** One creator-facing entry instead of asking the author to orchestrate tools. */
export function createOpenWorkspaceTool(service: CreatorService) {
  return defineTool({
    name: 'md2wechat_open_workspace',
    description: 'Open a Markdown article in the native WeChat creator workspace to preview, compare themes and review changes. Original files remain unchanged.',
    parameters: {
      sourcePath: { type: 'string', required: true, description: 'Markdown source inside this session workspace.' },
      title: { type: 'string', description: 'Optional article title.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        articleId: { type: 'string', required: true }, title: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: `已打开「${value.title}」。在文章工作区中查看预览、选择主题和审阅，不必手动编排工具。` }],
      presentationMeta: (_args, value) => ({ kind: 'md2wechat-creator', schemaVersion: 1, articleId: value.articleId }),
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('请在文章所属的会话中打开工作区。')
      const view = await service.open(exec.agent, args.sourcePath, args.title ?? '', exec.signal)
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
      service.propose(exec.agent, args.articleId, args.version, args.requestId, args.changes)
      return { accepted: true }
    },
  })
}
