import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessOutcome, SubprocessOutputRead } from '@deepseek-ai/dsh-subprocess'
import type { ResolvedConfig } from '../config.ts'
import { sanitizeError } from '../security/redaction.ts'
import { validateCliEnvelope } from './protocol.ts'
import type { CliEnvelope } from './protocol.ts'

const STDOUT_LIMIT_BYTES = 1024 * 1024
const STDERR_LIMIT_BYTES = 64 * 1024
const PROCESS_GRACE_MS = 5_000

/** Commands the compatible external CLI must advertise. */
export const REQUIRED_CLI_COMMANDS = [
  'inspect',
  'advise',
  'preview',
  'config',
  'write',
  'humanize',
  'title',
  'upload_image',
  'download_and_upload',
  'generate_image',
  'generate_cover',
  'generate_infographic',
  'create_draft',
  'providers',
  'capabilities',
  'version',
] as const

/** Options for one external CLI invocation. */
export interface CliRunOptions {
  cwd?: string
  env?: Readonly<Record<string, string>>
  secrets?: readonly string[]
  signal?: AbortSignal
  stdin?: string
  timeoutMs?: number
  beforeSpawn?: () => void | Promise<void>
}

/** Managed access to the configured external md2wechat executable. */
export interface CliGateway {
  /** Resolve the configured absolute executable in the subprocess provider's execution world. */
  resolve(signal?: AbortSignal): Promise<string>
  /** Run one argument vector and return its validated JSON envelope. */
  run(argv: readonly string[], options?: CliRunOptions): Promise<CliEnvelope>
}

interface AbortControl {
  signal: AbortSignal
  classify(error: unknown): Error
  dispose(): void
}

/**
 * Create the only adapter allowed to execute the configured md2wechat CLI.
 * @param ctx - Harness context that owns the managed subprocess service.
 * @param config - Resolved plugin configuration.
 * @returns managed CLI gateway.
 */
export function createCliGateway(ctx: Context, config: ResolvedConfig): CliGateway {
  const resolve = (signal?: AbortSignal): Promise<string> =>
    ctx.subprocess.resolveExecutable(config.binaryPath, {}, signal)

  return {
    resolve,
    async run(argv, options = {}) {
      const control = createAbortControl(options.signal, options.timeoutMs ?? config.foregroundTimeoutMs)
      const secrets = options.secrets ?? []
      try {
        return await runWithRetries(ctx, config, resolve, argv, options, control.signal)
      } catch (error) {
        throw sanitizeError(control.classify(error), secrets)
      } finally {
        control.dispose()
      }
    },
  }
}

async function runWithRetries(
  ctx: Context,
  config: ResolvedConfig,
  resolve: (signal?: AbortSignal) => Promise<string>,
  argv: readonly string[],
  options: CliRunOptions,
  signal: AbortSignal,
): Promise<CliEnvelope> {
  const safeRead = isSafeRead(argv)
  for (let attempt = 0; ; attempt += 1) {
    try {
      const envelope = await runOnce(ctx, resolve, argv, options, signal)
      if (!safeRead || envelope.success || !envelope.retryable || attempt >= config.safeReadRetries) return envelope
    } catch (error) {
      if (signal.aborted || !safeRead || attempt >= config.safeReadRetries) throw error
    }
    await delay(config.safeReadRetryDelayMs, undefined, { signal })
  }
}

async function runOnce(
  ctx: Context,
  resolve: (signal?: AbortSignal) => Promise<string>,
  argv: readonly string[],
  options: CliRunOptions,
  signal: AbortSignal,
): Promise<CliEnvelope> {
  const executable = await resolve(signal)
  await options.beforeSpawn?.()
  signal.throwIfAborted()

  const handle = ctx.subprocess.spawn({
    argv: [executable, ...argv],
    cwd: options.cwd ?? process.cwd(),
    stdio: {
      stdin: options.stdin === undefined ? 'ignore' : { data: options.stdin },
      stdout: { maxBytes: STDOUT_LIMIT_BYTES },
      stderr: { maxBytes: STDERR_LIMIT_BYTES },
    },
    graceMs: PROCESS_GRACE_MS,
    signal,
    env: options.env === undefined ? {} : { ...options.env },
  })

  let outcome: SubprocessOutcome
  try {
    outcome = await handle.done
  } catch (error) {
    await handle.waitForExit()
    throw error
  }
  await handle.waitForExit()
  signal.throwIfAborted()

  const stdout = readCollected(handle.collected.stdout?.readFrom(0), 'stdout')
  const stderr = readCollected(handle.collected.stderr?.readFrom(0), 'stderr')
  if (stdout.lossy) throw new Error('CLI stdout exceeded the one-megabyte output limit')
  if (stderr.lossy) throw new Error('CLI stderr exceeded the 64-KiB diagnostic output limit')
  if (outcome.signal !== null) {
    throw diagnosticError(`CLI process terminated by ${outcome.signal}`, stderr.text)
  }

  let value: unknown
  try {
    value = JSON.parse(stdout.text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw diagnosticError(`CLI stdout must contain exactly one JSON value: ${detail}`, stderr.text)
  }

  const envelope = validateCliEnvelope(value, {
    argv,
    requiredCommands: isCapabilityProbe(argv) ? REQUIRED_CLI_COMMANDS : [],
  })
  const exitCode = outcome.exitCode
  if (exitCode === null) throw diagnosticError('CLI process exited without a code', stderr.text)
  if ((exitCode === 0) !== envelope.success) {
    throw diagnosticError(
      `CLI exit code ${exitCode} conflicts with response success ${String(envelope.success)}`,
      stderr.text,
    )
  }
  return envelope
}

function readCollected(output: SubprocessOutputRead | undefined, stream: 'stdout' | 'stderr'): SubprocessOutputRead {
  if (output === undefined) throw new Error(`CLI ${stream} was not collected`)
  return output
}

function diagnosticError(message: string, diagnostic: string): Error {
  const text = diagnostic.trim()
  return new Error(text.length === 0 ? message : `${message}: ${text}`)
}

function isCapabilityProbe(argv: readonly string[]): boolean {
  return argv.length === 2 && argv[0] === 'capabilities' && argv[1] === '--json'
}

function isSafeRead(argv: readonly string[]): boolean {
  if (argv.length === 2 && argv[1] === '--json') {
    return argv[0] === 'version' || argv[0] === 'capabilities'
  }
  if (!argv.includes('--json')) return false
  switch (argv[0]) {
    case 'providers':
      return argv[1] === 'list' || argv[1] === 'show'
    case 'config':
      return argv[1] === 'show' || argv[1] === 'validate' || argv[1] === 'wechat-accounts'
    default:
      return false
  }
}

function createAbortControl(external: AbortSignal | undefined, timeoutMs: number): AbortControl {
  let kind: 'cancelled' | 'timed out' | undefined = external?.aborted ? 'cancelled' : undefined
  const timeout = new AbortController()
  const onCancel = (): void => { kind ??= 'cancelled' }
  external?.addEventListener('abort', onCancel, { once: true })
  const timer = setTimeout(() => {
    kind ??= 'timed out'
    timeout.abort()
  }, timeoutMs)
  const signal = external === undefined
    ? timeout.signal
    : AbortSignal.any([external, timeout.signal])

  return {
    signal,
    classify(error) {
      return kind === undefined
        ? error instanceof Error ? error : new Error(String(error))
        : new Error(`CLI command ${kind}`)
    },
    dispose() {
      clearTimeout(timer)
      external?.removeEventListener('abort', onCancel)
    },
  }
}
