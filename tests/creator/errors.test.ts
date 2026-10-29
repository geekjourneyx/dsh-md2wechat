import { expect, it } from 'vitest'
import { creatorRemoteError, creatorErrorInfo, creatorCliError } from '../../src/creator/errors.ts'
it.each([
  ['CLI command timed out', 'CLI_TIMEOUT'],
  ['CLI command cancelled', 'OPERATION_CANCELLED'],
  ['交付未获授权，未执行上传或提交。', 'OPERATION_CANCELLED'],
  ['无法读取交付所需凭据，请检查配置。', 'CREDENTIALS_MISSING'],
  ['无法读取排版主题，请检查 md2wechat。', 'CLI_UNAVAILABLE'],
  ['article preview failed', 'PREVIEW_FAILED'],
  ['private token=secret', 'OPERATION_FAILED'],
])('carries %s safely through a message-only host error', (message, code) => {
  const error = creatorRemoteError(new Error(message))
  const result = creatorErrorInfo({ message: error.message })
  expect(result.code).toBe(code)
  expect(result.message).not.toMatch(/secret|private|token=/u)
  expect(result.actions).not.toContain('import-new')
})
it('does not guess from arbitrary provider prose or unknown error codes', () => {
  const result = creatorErrorInfo(creatorCliError({ code: 'UNKNOWN token=secret' }))
  expect(result.code).toBe('OPERATION_FAILED')
  expect(result.message).not.toContain('配置')
})
