/** Finite browser-safe article failures; raw backend diagnostics never cross this boundary. */
export type CreatorErrorCode = 'PREVIEW_TITLE_INVALID' | 'PREVIEW_AUTHOR_INVALID' | 'PREVIEW_DIGEST_INVALID' | 'PREVIEW_FAILED' | 'PREVIEW_RESPONSE_INVALID' | 'CLI_TIMEOUT' | 'OPERATION_CANCELLED' | 'CREDENTIALS_MISSING' | 'API_KEY_INVALID' | 'API_UNREACHABLE' | 'CLI_UNAVAILABLE' | 'LAYOUT_INVALID' | 'LAYOUT_LIMIT' | 'OPERATION_FAILED' | 'IMAGE_INVALID' | 'TITLE_INVALID' | 'IMPORT_INVALID' | 'IMPORT_IMAGES' | 'ARTICLE_NOT_FOUND' | 'RECOVERY_REQUIRED' | 'PERMISSION_DENIED' | 'SOURCE_CHANGED' | 'ARTIFACT_INVALID' | 'VERSION_CONFLICT' | 'HOST_UNAVAILABLE'
export type CreatorRecoveryAction = 'open-source' | 'recover-revision' | 'check-permissions' | 'select-session' | 'continue' | 'import-new' | 'check-artifacts' | 'refresh' | 'retry'
export interface CreatorErrorInfo { code: CreatorErrorCode; message: string; actions: CreatorRecoveryAction[] }

const failures: Record<CreatorErrorCode, { message: string; actions: readonly CreatorRecoveryAction[] }> = {
  PREVIEW_TITLE_INVALID: { message: '文章标题超过 32 个字符，当前插件无法显示这份预览。请点击「编辑标题」缩短标题后重新预览；原文未更改。', actions: [] },
  PREVIEW_AUTHOR_INVALID: { message: '文章作者超过 16 个字符，当前插件无法显示这份预览。请缩短文章头部的作者信息后重新预览；原文未更改。', actions: [] },
  PREVIEW_DIGEST_INVALID: { message: '文章摘要超过 128 个字符，当前插件无法显示这份预览。请缩短文章头部的摘要后重新预览；原文未更改。', actions: [] },
  PREVIEW_FAILED: { message: '预览未完成，尚未确认具体原因。原文未更改；请保留这次会话记录用于排查，不必反复修改配置。', actions: [] },
  PREVIEW_RESPONSE_INVALID: { message: '排版返回的结果未通过插件检查，不能显示为有效预览。原文未更改；请核对插件与 md2wechat 版本是否兼容。', actions: [] },
  CLI_TIMEOUT: { message: '等待 md2wechat 处理超时，暂未拿到结果。请检查网络和服务状态；涉及上传或草稿时，先核对公众号后台再决定是否重试。', actions: [] },
  OPERATION_CANCELLED: { message: '操作已取消或未获授权。请确认是否继续；若已经开始上传或保存草稿，先核对公众号后台，避免重复提交。', actions: [] },
  CREDENTIALS_MISSING: { message: '无法读取此操作需要的凭据。请在 DSH 中检查排版密钥；上传和保存草稿还需要公众号 AppID 与 Secret。不要把密钥贴进对话。', actions: [] },
  API_KEY_INVALID: { message: '排版服务拒绝了当前密钥。请检查密钥是否完整、有效，必要时联系服务提供方；修改文章内容不能解决此问题。', actions: [] },
  API_UNREACHABLE: { message: '无法连接排版密钥验证服务。请检查网络、代理和服务地址；这不代表密钥已被判定无效。', actions: [] },
  CLI_UNAVAILABLE: { message: '无法取得 md2wechat 所需能力。请检查安装、可执行文件路径和版本兼容性；文章无需重写。', actions: [] },
  LAYOUT_INVALID: { message: '高级排版模块未通过检查。请重新生成符合当前 md2wechat 模块规则的建议；尚未应用这次修改。', actions: [] },
  LAYOUT_LIMIT: { message: '应用后整篇文章将超过 8 个高级排版模块。请减少模块或替换已有模块；尚未应用这次修改。', actions: [] },
  OPERATION_FAILED: { message: '操作未完成，尚未确认具体原因。请保留这次会话记录用于排查；不要据此重新导入文章或重复上传、提交草稿。', actions: [] },
  IMAGE_INVALID: { message: '请选择不超过 8 MiB 的 PNG、JPEG、GIF 或 WebP 图片。', actions: ['retry'] },
  TITLE_INVALID: { message: '标题请填写 1–32 个字，不要换行或包含 HTML。', actions: ['retry'] },
  IMPORT_INVALID: { message: '请输入有效正文，文章不能超过 2 MiB。', actions: ['retry'] },
  IMPORT_IMAGES: { message: '文章引用了本地图片。请从工作目录选择原文件以保留图片；或移除图片引用后导入，再添加图片。', actions: ['open-source'] },
  ARTICLE_NOT_FOUND: { message: '没有找到这篇文章的保存记录。请选择原文，或从已有文章版本恢复。', actions: ['open-source', 'recover-revision'] },
  RECOVERY_REQUIRED: { message: '文章需要重新检查。请重新打开已保存文章，或选择原文恢复；未自动重试交付。', actions: ['open-source', 'recover-revision'] },
  PERMISSION_DENIED: { message: '当前会话无权完成此操作。请检查会话和工作区权限后重试。', actions: ['check-permissions', 'select-session'] },
  SOURCE_CHANGED: { message: '原文已变化。请选择继续已保存版本或重新导入，原文和已保存文章不会被覆盖。', actions: ['continue', 'import-new'] },
  ARTIFACT_INVALID: { message: '已保存文章或引用文件缺失、变化或无效。请检查文件，或重新打开原文；不会自动覆盖。', actions: ['check-artifacts', 'open-source'] },
  VERSION_CONFLICT: { message: '文章或预览已经更新。请加载最新版本并重新检查后再操作。', actions: ['refresh'] },
  HOST_UNAVAILABLE: { message: '文章服务暂时不可用或请求已取消。请重新选择会话后重试。', actions: ['retry', 'select-session'] },
}
const messages = new Map<string, CreatorErrorCode>()
function known(code: CreatorErrorCode, values: readonly string[]): void { for (const value of values) messages.set(value, code) }
// Exact messages from the existing service/runtime guards. Never classify by user paths or arbitrary substrings.
known('ARTICLE_NOT_FOUND', ['文章工作区已关闭或没有保存记录，请重新打开原文。', '文章工作区已关闭，请重新打开原文。'])
known('PERMISSION_DENIED', [
  '这篇文章不属于当前会话，请重新打开。',
  'creator document owner does not match the authenticated session',
  'creator document owner or article identity does not match its trusted binding',
  'creator document owner binding changed during read',
  'creator document owner does not match its trusted binding',
  'creator document owner binding could not be verified',
  'creator delivery owner does not match the authenticated session',
  '当前会话为只读，请在宿主中允许工作区写入后重试。',
  '只能写入当前会话的工作区，请选择工作区内的位置。',
  '文章原文必须位于当前会话工作区内。',
  '会话工作区已变化，请重新打开文章。',
  'creator document source path escapes the current workspace',
  'creator operation rejected by admission policy',
  'creator operation reservation was not admitted',
])
known('SOURCE_CHANGED', [
  '原文已变化，请明确选择继续已保存版本或重新导入；不会覆盖原文。',
  '原文已变化，请重新打开；已保存文章和原文未覆盖。',
  '文章原文位置已变化，请重试。',
])
known('VERSION_CONFLICT', [
  '文章已经更新，请查看最新预览后重试。', '文章已经更新，请重新核对。',
  '显示的预览已经变化，请等待当前版本加载完成后重新审阅。', '微信标题已变化，请检查标题后重新审阅。',
  '图片位置属于旧版本，请重新选择。', '文章已经变化，请重新选择图片位置。', '图片候选属于旧版本，请重新选择。',
])
known('ARTIFACT_INVALID', [
  'legacy revision must be a direct contained directory', 'legacy revision directory changed during recovery', 'legacy revision root is not a directory',
  '已保存文章版本不匹配，请检查恢复文件。', '历史版本不匹配，无法恢复撤回记录。', '历史版本已发生变化，不能撤回。',
  '图片内容已经变化，请重新导入。', 'creator document schema version is invalid', 'creator document fields are invalid',
  'creator document JSON must be a plain object', 'creator document revision manifest path is invalid',
  'stale revision: manifest, article, or directory identity does not match',
  'revision manifest must use revision-local article.md and manifest.json paths',
  'manifestPath must match revisions/<revision-id>/manifest.json',
  'artifact input does not exist', 'artifact input must be a regular file',
  'artifact input content changed before authorization', 'artifact must stay inside its immutable revision directory',
  'artifact path escapes the session workspace', 'artifact path escapes the configured artifact root',
])
known('HOST_UNAVAILABLE', [
  '当前宿主缺少文章工作区所需的会话权限服务。', '文章会话已关闭，请重新选择会话。',
  'creator operation agent disposed', 'creator operation runner disposed', 'creator operation cancelled',
  'creator operation turn ended before completion',
])
known('CREDENTIALS_MISSING', ['MD2WECHAT_API_KEY is not configured for article preview', '请先配置排版与公众号凭据。', '无法读取交付所需凭据，请检查配置。', '请先配置排版凭据。', '无法读取排版凭据，请检查配置。', 'fallback image credentials could not be resolved'])
known('CLI_TIMEOUT', ['CLI command timed out'])
known('OPERATION_CANCELLED', ['CLI command cancelled', 'article preview cancelled', '交付未获授权，未执行上传或提交。', 'article preview approval rejected', 'article preview approval cancelled', 'article preview approval unavailable'])
known('CLI_UNAVAILABLE', ['无法读取排版主题，请检查 md2wechat。', '没有可用的排版主题，请检查 md2wechat。', '文章检查失败，请确认当前 md2wechat 支持文章检查。'])
known('PREVIEW_FAILED', ['article preview failed'])
known('PREVIEW_RESPONSE_INVALID', ['文章检查未返回有效结果。'])
known('VERSION_CONFLICT', ['请重新生成当前文章预览，再导出。', '预览已经变化，请重新审阅。', '最终预览已过期，请重新准备并审阅。', '本地预览已过期，请重新生成并审阅。'])

/** Only documented codes are interpreted; provider prose, URLs and secrets are never displayed. */
export function creatorCliError(response: { code: string }): Error {
  const codes: Record<string, CreatorErrorCode> = { API_KEY_REQUIRED: 'CREDENTIALS_MISSING', API_KEY_INVALID: 'API_KEY_INVALID', API_KEY_VERIFY_FAILED: 'API_UNREACHABLE', PREVIEW_FAILED: 'PREVIEW_FAILED', PREVIEW_ACTION_REQUIRED: 'PREVIEW_RESPONSE_INVALID', LAYOUT_VALIDATE_HAS_ERRORS: 'LAYOUT_INVALID' }
  return creatorRemoteError(undefined, codes[response.code] ?? 'OPERATION_FAILED')
}
export function knownCreatorFailure(error: unknown): boolean { return marker(error) !== undefined || messages.has(field(error, 'message') ?? '') || systemCodes.has(field(error, 'code') ?? '') }
const systemCodes = new Map<string, CreatorErrorCode>([
  ['EACCES', 'PERMISSION_DENIED'], ['EPERM', 'PERMISSION_DENIED'],
  ['remote-access/denied', 'PERMISSION_DENIED'], ['gateway/interactions-forbidden', 'PERMISSION_DENIED'],
  ['FS_PERMISSION_DENIED', 'PERMISSION_DENIED'], ['FS_SANDBOX_DENIED', 'PERMISSION_DENIED'],
  ['FS_STALE_VERSION', 'VERSION_CONFLICT'],
  ['FS_NOT_FOUND', 'ARTIFACT_INVALID'], ['ENOENT', 'ARTIFACT_INVALID'],
  ['FS_NOT_DIRECTORY', 'ARTIFACT_INVALID'], ['FS_NOT_TEXT', 'ARTIFACT_INVALID'], ['FS_NOT_REGULAR_FILE', 'ARTIFACT_INVALID'], ['FS_TOO_LARGE', 'ARTIFACT_INVALID'],
  ['ECONNRESET', 'HOST_UNAVAILABLE'], ['ECONNREFUSED', 'HOST_UNAVAILABLE'], ['ETIMEDOUT', 'HOST_UNAVAILABLE'], ['FS_ABORTED', 'HOST_UNAVAILABLE'],
])
function field(error: unknown, key: 'message' | 'code' | 'name'): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  try {
    const value: unknown = Reflect.get(error, key)
    return typeof value === 'string' ? value : undefined
  } catch { return undefined }
}
function marker(error: unknown): CreatorErrorCode | undefined {
  const match = /^\[md2wechat:([A-Z_]+)\](?: |$)/u.exec(field(error, 'message') ?? '')
  return match && Object.hasOwn(failures, match[1]!) ? match[1] as CreatorErrorCode : undefined
}
function info(code: CreatorErrorCode): CreatorErrorInfo { return { code, message: failures[code].message, actions: [...failures[code].actions] } }

/** Decode message-only Remote errors on either supported host; unknown RPC failures are unavailable, not missing articles. */
export function creatorErrorInfo(error: unknown): CreatorErrorInfo { return info(marker(error) ?? systemCodes.get(field(error, 'code') ?? '') ?? 'HOST_UNAVAILABLE') }

/** New Error without cause/custom fields: both hosts preserve this finite marker in Error.message. */
export function creatorRemoteError(error: unknown, fallback: CreatorErrorCode = 'OPERATION_FAILED'): Error {
  const code = marker(error) ?? messages.get(field(error, 'message') ?? '') ?? systemCodes.get(field(error, 'code') ?? '') ?? (field(error, 'name') === 'SyntaxError' ? 'ARTIFACT_INVALID' : fallback)
  return new Error(`[md2wechat:${code}] ${failures[code].message}`)
}
