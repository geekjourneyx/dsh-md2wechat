import { isAbsolute } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

const DEFAULT_ARTIFACTS_DIR = '.dsh/md2wechat'
const DEFAULT_LAYOUT_BASE_URL = 'https://www.md2wechat.cn'
const DEFAULT_SAFE_READ_RETRIES = 1
const DEFAULT_SAFE_READ_RETRY_DELAY_MS = 500
const DEFAULT_FOREGROUND_TIMEOUT_MS = 120_000
const DEFAULT_IMAGE_JOB_TIMEOUT_MS = 900_000

const credentialEnvironmentNames = new Set<CredentialEnvironmentName>([
  'MD2WECHAT_API_KEY',
  'WECHAT_APPID',
  'WECHAT_SECRET',
  'IMAGE_API_KEY',
])

/** Plugin configuration supplied by the host. */
export interface Config {
  binaryPath: string
  artifactsDir?: string
  layoutBaseUrl?: string
  enableWechatWriteTools?: boolean
  enableFallbackImageTool?: boolean
  safeReadRetries?: number
  safeReadRetryDelayMs?: number
  foregroundTimeoutMs?: number
  imageJobTimeoutMs?: number
  credentialRefs?: Readonly<Record<CredentialEnvironmentName, string>>
}

/** Environment variables accepted as references to external credentials. */
export type CredentialEnvironmentName =
  | 'MD2WECHAT_API_KEY'
  | 'WECHAT_APPID'
  | 'WECHAT_SECRET'
  | 'IMAGE_API_KEY'

/** Fully resolved configuration used by the plugin at runtime. */
export interface ResolvedConfig {
  binaryPath: string
  artifactsDir: string
  layoutBaseUrl: string
  enableWechatWriteTools: boolean
  enableFallbackImageTool: boolean
  safeReadRetries: number
  safeReadRetryDelayMs: number
  foregroundTimeoutMs: number
  imageJobTimeoutMs: number
  credentialRefs: Readonly<Record<string, string>>
}

const configFields = {
  binaryPath: Schema.string().required(),
  artifactsDir: Schema.string(),
  layoutBaseUrl: Schema.string(),
  enableWechatWriteTools: Schema.boolean(),
  enableFallbackImageTool: Schema.boolean(),
  safeReadRetries: Schema.number(),
  safeReadRetryDelayMs: Schema.number(),
  foregroundTimeoutMs: Schema.number(),
  imageJobTimeoutMs: Schema.number(),
  credentialRefs: Schema.dict(Schema.string()) as unknown as Schema<Readonly<Record<CredentialEnvironmentName, string>>>,
}

Schema.extend('dsh-md2wechat-config', (data, schema, options) => {
  const [resolved] = Schema.resolve(data, Schema.object(schema.dict!), options, true)
  for (const key of Object.keys(data)) {
    if (!(key in schema.dict!)) throw new Schema.ValidationError('unknown configuration field', options)
  }
  return [resolved]
})

/** Host-facing configuration schema with an explicit required binary path. */
export const Config: Schema<Config> = Schema<Config>({
  type: 'dsh-md2wechat-config',
  dict: configFields,
})

const configKeys = new Set<keyof Config>(Object.keys(configFields) as (keyof Config)[])

/**
 * Validate host configuration and apply the plugin's safe defaults.
 * @param input - Configuration received from the host runtime.
 * @returns validated configuration ready for command execution.
 */
export function resolveConfig(input: Config): ResolvedConfig {
  const value = asPlainObject(input, 'configuration must be an object')
  for (const key of Object.keys(value)) {
    if (!configKeys.has(key as keyof Config)) throw new TypeError('unknown configuration field')
  }

  const binaryPath = requiredString(value.binaryPath, 'binaryPath must be a string')
  if (!isAbsolute(binaryPath)) throw new TypeError('binaryPath must be an absolute path')

  const artifactsDir = optionalString(value.artifactsDir, DEFAULT_ARTIFACTS_DIR, 'artifactsDir must be a string')
  if (!isSessionWorkspacePath(artifactsDir)) throw new TypeError('artifactsDir must stay within the session workspace')

  return {
    binaryPath,
    artifactsDir,
    layoutBaseUrl: optionalString(value.layoutBaseUrl, DEFAULT_LAYOUT_BASE_URL, 'layoutBaseUrl must be a string'),
    enableWechatWriteTools: optionalBoolean(value.enableWechatWriteTools, true, 'enableWechatWriteTools must be a boolean'),
    enableFallbackImageTool: optionalBoolean(value.enableFallbackImageTool, true, 'enableFallbackImageTool must be a boolean'),
    safeReadRetries: optionalInteger(value.safeReadRetries, DEFAULT_SAFE_READ_RETRIES, 0, 'safeReadRetries must be a non-negative integer'),
    safeReadRetryDelayMs: optionalInteger(value.safeReadRetryDelayMs, DEFAULT_SAFE_READ_RETRY_DELAY_MS, 0, 'safeReadRetryDelayMs must be a non-negative integer'),
    foregroundTimeoutMs: optionalInteger(value.foregroundTimeoutMs, DEFAULT_FOREGROUND_TIMEOUT_MS, 1, 'foregroundTimeoutMs must be a positive integer'),
    imageJobTimeoutMs: optionalInteger(value.imageJobTimeoutMs, DEFAULT_IMAGE_JOB_TIMEOUT_MS, 1, 'imageJobTimeoutMs must be a positive integer'),
    credentialRefs: resolveCredentialRefs(value.credentialRefs),
  }
}

function asPlainObject(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(message)
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(message)
  return value
}

function optionalString(value: unknown, fallback: string, message: string): string {
  if (value === undefined) return fallback
  return requiredString(value, message)
}

function optionalBoolean(value: unknown, fallback: boolean, message: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new TypeError(message)
  return value
}

function optionalInteger(value: unknown, fallback: number, minimum: number, message: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) throw new TypeError(message)
  return value
}

function isSessionWorkspacePath(value: string): boolean {
  return value.length > 0 && !isAbsolute(value) && !value.split(/[\\/]+/u).includes('..')
}

function resolveCredentialRefs(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return {}
  const refs = asPlainObject(value, 'credentialRefs must be an object')
  const resolved: Record<string, string> = {}
  for (const [name, reference] of Object.entries(refs)) {
    if (!credentialEnvironmentNames.has(name as CredentialEnvironmentName)) {
      throw new TypeError(`credential environment name ${name} is not supported`)
    }
    resolved[name] = requiredString(reference, 'credential reference must be a non-empty string')
  }
  return resolved
}
