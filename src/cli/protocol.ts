import { SUPPORTED_CLI_VERSION } from '../version.ts'

/** Lifecycle states emitted by the external CLI. */
export type CliStatus = 'completed' | 'action_required' | 'failed'

/** Context that determines the additional response facts a CLI call must provide. */
export interface CliRequestContext {
  argv: readonly string[]
  requiredCommands: readonly string[]
}

/** JSON response accepted from the external CLI. */
export interface CliEnvelope {
  success: boolean
  code: string
  message: string
  schema_version: 'v1'
  status: CliStatus
  retryable: boolean
  data?: Readonly<Record<string, unknown>>
  error?: string
  error_details?: Readonly<Record<string, unknown>>
  next_actions?: readonly unknown[]
}

const envelopeKeys = new Set<keyof CliEnvelope>([
  'success',
  'code',
  'message',
  'schema_version',
  'status',
  'retryable',
  'data',
  'error',
  'error_details',
  'next_actions',
])

/**
 * Narrow an untrusted JSON response and verify request-specific CLI guarantees.
 * @param value - Parsed stdout JSON from the CLI process.
 * @param request - Arguments and required capabilities for the process call.
 * @returns a verified CLI envelope.
 */
export function validateCliEnvelope(value: unknown, request: CliRequestContext): CliEnvelope {
  const envelope = asPlainObject(value, 'CLI response must be an object')
  for (const key of Object.keys(envelope)) {
    if (!envelopeKeys.has(key as keyof CliEnvelope)) throw new TypeError('CLI response contains an unsupported field')
  }

  const success = requiredBoolean(envelope.success, 'CLI response success must be a boolean')
  const code = requiredString(envelope.code, 'CLI response code must be a string')
  const message = requiredString(envelope.message, 'CLI response message must be a string')
  if (envelope.schema_version !== 'v1') throw new TypeError('unsupported CLI schema_version')
  const status = validateStatus(envelope.status)
  const retryable = requiredBoolean(envelope.retryable, 'CLI response retryable must be a boolean')
  const data = envelope.data === undefined ? undefined : validateJsonRecord(envelope.data, 'data')
  const error = envelope.error === undefined
    ? undefined
    : requiredString(envelope.error, 'CLI response error must be a string')
  const errorDetails = envelope.error_details === undefined
    ? undefined
    : validateJsonRecord(envelope.error_details, 'error_details')
  const nextActions = envelope.next_actions === undefined ? undefined : validateJsonArray(envelope.next_actions, 'next_actions')

  validateStatusSuccess(status, success)
  validateCapabilities(data, request.requiredCommands)
  validateVersion(data, request.argv)

  return {
    success,
    code,
    message,
    schema_version: 'v1',
    status,
    retryable,
    ...(data === undefined ? {} : { data }),
    ...(error === undefined ? {} : { error }),
    ...(errorDetails === undefined ? {} : { error_details: errorDetails }),
    ...(nextActions === undefined ? {} : { next_actions: nextActions }),
  }
}

function validateStatus(value: unknown): CliStatus {
  switch (value) {
    case 'completed':
    case 'action_required':
    case 'failed':
      return value
    default:
      throw new TypeError('unsupported CLI status')
  }
}

function validateStatusSuccess(status: CliStatus, success: boolean): void {
  switch (status) {
    case 'completed':
    case 'action_required':
      if (!success) throw new TypeError('CLI response success conflicts with status')
      return
    case 'failed':
      if (success) throw new TypeError('CLI response success conflicts with status')
      return
    default:
      return assertNever(status)
  }
}

function validateCapabilities(data: Readonly<Record<string, unknown>> | undefined, requiredCommands: readonly string[]): void {
  const commands = data?.commands
  if (commands !== undefined && (!Array.isArray(commands) || !commands.every(item => typeof item === 'string'))) {
    throw new TypeError('CLI response commands must contain only strings')
  }
  for (const command of requiredCommands) {
    if (!Array.isArray(commands) || !commands.includes(command)) {
      throw new TypeError(`CLI response is missing required command ${command}`)
    }
  }
}

function validateVersion(data: Readonly<Record<string, unknown>> | undefined, argv: readonly string[]): void {
  if (argv[0] !== 'version') return
  if (data?.version !== SUPPORTED_CLI_VERSION) {
    throw new TypeError(`unsupported CLI version; expected ${SUPPORTED_CLI_VERSION}`)
  }
}

function validateJsonRecord(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) throw new TypeError(`CLI response ${field} must be an object`)
  return validateJsonValue(value, field, new Set()) as Readonly<Record<string, unknown>>
}

function validateJsonArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`CLI response ${field} must be an array`)
  return validateJsonValue(value, field, new Set()) as readonly unknown[]
}

function validateJsonValue(value: unknown, field: string, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value
    throw new TypeError(`CLI response ${field} must contain JSON values`)
  }
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError(`CLI response ${field} must contain JSON values`)

  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map(item => validateJsonValue(item, field, ancestors))
    if (!isPlainObject(value)) throw new TypeError(`CLI response ${field} must contain JSON values`)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, validateJsonValue(item, field, ancestors)]))
  } finally {
    ancestors.delete(value)
  }
}

function asPlainObject(value: unknown, message: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new TypeError(message)
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function requiredBoolean(value: unknown, message: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(message)
  return value
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== 'string') throw new TypeError(message)
  return value
}

function assertNever(value: never): never {
  throw new TypeError(`unsupported CLI status ${String(value)}`)
}
