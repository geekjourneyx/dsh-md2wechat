import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

const DEFAULT_ARTIFACTS_DIR = '.dsh/md2wechat'
const DEFAULT_LAYOUT_BASE_URL = 'https://www.md2wechat.cn'
const DEFAULT_PREVIEW_THEME = 'default'
const DEFAULT_PREVIEW_FONT_SIZE = 'medium'
const DEFAULT_PREVIEW_BACKGROUND_TYPE = 'none'
const DEFAULT_SAFE_READ_RETRIES = 1
const DEFAULT_SAFE_READ_RETRY_DELAY_MS = 500
const DEFAULT_FOREGROUND_TIMEOUT_MS = 120_000
const DEFAULT_IMAGE_JOB_TIMEOUT_MS = 900_000
const DEFAULT_IMAGE_MAX_BYTES = 20 * 1024 * 1024
const DEFAULT_IMAGE_MAX_REDIRECTS = 3
const DEFAULT_IMAGE_ACQUISITION_TIMEOUT_MS = 60_000
const MAX_IMAGE_BYTES = 64 * 1024 * 1024

const credentialEnvironmentNames = new Set<CredentialEnvironmentName>([
  'MD2WECHAT_API_KEY',
  'WECHAT_APPID',
  'WECHAT_SECRET',
  'IMAGE_API_KEY',
])

/** Plugin configuration supplied by the host. */
export interface Config {
  binaryPath?: string
  artifactsDir?: string
  stateDir?: string
  layoutBaseUrl?: string
  previewTheme?: string
  previewFontSize?: 'small' | 'medium' | 'large'
  previewBackgroundType?: 'default' | 'grid' | 'none'
  enableWechatWriteTools?: boolean
  enableFallbackImageTool?: boolean
  safeReadRetries?: number
  safeReadRetryDelayMs?: number
  foregroundTimeoutMs?: number
  imageJobTimeoutMs?: number
  imageMaxBytes?: number
  imageMaxRedirects?: number
  imageAcquisitionTimeoutMs?: number
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
  stateDir: string
  layoutBaseUrl: string
  previewTheme: string
  previewFontSize: 'small' | 'medium' | 'large'
  previewBackgroundType: 'default' | 'grid' | 'none'
  enableWechatWriteTools: boolean
  enableFallbackImageTool: boolean
  safeReadRetries: number
  safeReadRetryDelayMs: number
  foregroundTimeoutMs: number
  imageJobTimeoutMs: number
  imageMaxBytes: number
  imageMaxRedirects: number
  imageAcquisitionTimeoutMs: number
  credentialRefs: Readonly<Record<string, string>>
}

const configFields = {
  binaryPath: Schema.string(),
  artifactsDir: Schema.string(),
  stateDir: Schema.string(),
  layoutBaseUrl: Schema.string(),
  previewTheme: Schema.string(),
  previewFontSize: Schema.union(['small', 'medium', 'large']),
  previewBackgroundType: Schema.union(['default', 'grid', 'none']),
  enableWechatWriteTools: Schema.boolean(),
  enableFallbackImageTool: Schema.boolean(),
  safeReadRetries: Schema.number(),
  safeReadRetryDelayMs: Schema.number(),
  foregroundTimeoutMs: Schema.number(),
  imageJobTimeoutMs: Schema.number(),
  imageMaxBytes: Schema.number(),
  imageMaxRedirects: Schema.number(),
  imageAcquisitionTimeoutMs: Schema.number(),
  credentialRefs: Schema.dict(Schema.string()) as unknown as Schema<Readonly<Record<CredentialEnvironmentName, string>>>,
}

Schema.extend('dsh-md2wechat-config', (data, schema, options) => {
  const [resolved] = Schema.resolve(data, Schema.object(schema.dict!), options, true)
  for (const key of Object.keys(data)) {
    if (!(key in schema.dict!)) throw new Schema.ValidationError('unknown configuration field', options)
  }
  return [resolved]
})

/** Host-facing configuration schema with optional explicit executable selection. */
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

  const binaryPath = value.binaryPath === undefined ? 'md2wechat' : requiredString(value.binaryPath, 'binaryPath must be a string')
  if (binaryPath !== 'md2wechat' && !isAbsolute(binaryPath)) throw new TypeError('binaryPath must be an absolute executable path or the host PATH command md2wechat')

  const artifactsDir = optionalString(value.artifactsDir, DEFAULT_ARTIFACTS_DIR, 'artifactsDir must be a string')
  if (!isSessionWorkspacePath(artifactsDir)) throw new TypeError('artifactsDir must stay within the session workspace')
  const stateDir = value.stateDir === undefined
    ? defaultStateDir()
    : requiredString(value.stateDir, 'stateDir must be a string')
  if (!isAbsolute(stateDir)) throw new TypeError('stateDir must be an absolute path')

  return {
    binaryPath,
    artifactsDir,
    stateDir,
    layoutBaseUrl: optionalString(value.layoutBaseUrl, DEFAULT_LAYOUT_BASE_URL, 'layoutBaseUrl must be a string'),
    previewTheme: optionalString(value.previewTheme, DEFAULT_PREVIEW_THEME, 'previewTheme must be a string'),
    previewFontSize: optionalEnum(value.previewFontSize, DEFAULT_PREVIEW_FONT_SIZE, ['small', 'medium', 'large'], 'previewFontSize must be a supported value'),
    previewBackgroundType: optionalEnum(value.previewBackgroundType, DEFAULT_PREVIEW_BACKGROUND_TYPE, ['default', 'grid', 'none'], 'previewBackgroundType must be a supported value'),
    enableWechatWriteTools: optionalBoolean(value.enableWechatWriteTools, true, 'enableWechatWriteTools must be a boolean'),
    enableFallbackImageTool: optionalBoolean(value.enableFallbackImageTool, true, 'enableFallbackImageTool must be a boolean'),
    safeReadRetries: optionalInteger(value.safeReadRetries, DEFAULT_SAFE_READ_RETRIES, 0, 'safeReadRetries must be a non-negative integer'),
    safeReadRetryDelayMs: optionalInteger(value.safeReadRetryDelayMs, DEFAULT_SAFE_READ_RETRY_DELAY_MS, 0, 'safeReadRetryDelayMs must be a non-negative integer'),
    foregroundTimeoutMs: optionalInteger(value.foregroundTimeoutMs, DEFAULT_FOREGROUND_TIMEOUT_MS, 1, 'foregroundTimeoutMs must be a positive integer'),
    imageJobTimeoutMs: optionalInteger(value.imageJobTimeoutMs, DEFAULT_IMAGE_JOB_TIMEOUT_MS, 1, 'imageJobTimeoutMs must be a positive integer'),
    imageMaxBytes: optionalInteger(value.imageMaxBytes, DEFAULT_IMAGE_MAX_BYTES, 1, 'imageMaxBytes must be a positive integer', MAX_IMAGE_BYTES),
    imageMaxRedirects: optionalInteger(value.imageMaxRedirects, DEFAULT_IMAGE_MAX_REDIRECTS, 0, 'imageMaxRedirects must be a non-negative integer'),
    imageAcquisitionTimeoutMs: optionalInteger(value.imageAcquisitionTimeoutMs, DEFAULT_IMAGE_ACQUISITION_TIMEOUT_MS, 1, 'imageAcquisitionTimeoutMs must be a positive integer'),
    credentialRefs: resolveCredentialRefs(value.credentialRefs),
  }
}

function defaultStateDir(): string {
  const configuredHome = process.env.DSH_HOME?.trim()
  const dshHome = configuredHome === undefined || configuredHome === '' ? join(homedir(), '.dsh') : configuredHome
  if (!isAbsolute(dshHome)) throw new TypeError('DSH_HOME must be an absolute path when used for stateDir')
  return join(dshHome, 'plugins', 'dsh-md2wechat')
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

function optionalEnum<const T extends string>(value: unknown, fallback: T, allowed: readonly T[], message: string): T {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new TypeError(message)
  return value as T
}

function optionalInteger(value: unknown, fallback: number, minimum: number, message: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(typeof value === 'number' && value > maximum ? `${message}; maximum is ${maximum}` : message)
  }
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
