/** Finite browser-safe article failures; raw backend diagnostics never cross this boundary. */
export type CreatorErrorCode = 'ARTICLE_NOT_FOUND' | 'RECOVERY_REQUIRED' | 'PERMISSION_DENIED' | 'SOURCE_CHANGED' | 'ARTIFACT_INVALID' | 'VERSION_CONFLICT' | 'HOST_UNAVAILABLE'
export type CreatorRecoveryAction = 'open-source' | 'recover-revision' | 'check-permissions' | 'select-session' | 'continue' | 'import-new' | 'check-artifacts' | 'refresh' | 'retry'
export interface CreatorErrorInfo { code: CreatorErrorCode; message: string; actions: CreatorRecoveryAction[] }

const failures: Record<CreatorErrorCode, { message: string; actions: readonly CreatorRecoveryAction[] }> = {
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
  '无法读取排版主题，请检查 md2wechat。', '没有可用的排版主题，请检查 md2wechat。',
  'creator operation agent disposed', 'creator operation runner disposed', 'creator operation cancelled',
  'creator operation turn ended before completion',
])
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
export function creatorRemoteError(error: unknown, fallback: CreatorErrorCode = 'RECOVERY_REQUIRED'): Error {
  const code = marker(error) ?? messages.get(field(error, 'message') ?? '') ?? systemCodes.get(field(error, 'code') ?? '') ?? (field(error, 'name') === 'SyntaxError' ? 'ARTIFACT_INVALID' : fallback)
  return new Error(`[md2wechat:${code}] ${failures[code].message}`)
}
