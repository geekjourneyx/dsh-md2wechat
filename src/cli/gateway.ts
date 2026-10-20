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
  beforeSpawn?: (signal: AbortSignal) => void | Promise<void>
}

/** Managed access to the configured external md2wechat executable. */
export interface CliGateway {
  /** Last successfully observed version, scoped to this gateway only. */
  readonly version?: string | undefined
  /** Re-probe version and required capabilities before version-bound operations. */
  probeVersion?(signal?: AbortSignal): Promise<string>
  /** Resolve the explicit executable or host PATH command in the subprocess provider's execution world. */
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
  let version: string | undefined
  const resolve = async (signal?: AbortSignal): Promise<string> => {
    try {
      return await ctx.subprocess.resolveExecutable(config.binaryPath, {}, signal)
    } catch {
      const message = signal?.aborted
        ? 'configured md2wechat executable resolution cancelled'
        : 'configured md2wechat executable could not be resolved. Set MD2WECHAT_BINARY_PATH to the verified executable file (not its install directory), or make md2wechat available on the DSH host process PATH; then restart that host. An explicit path never falls back to a different CLI.'
      throw sanitizeError(new Error(message), [...(config.binaryPath === 'md2wechat' ? [] : [config.binaryPath]), ...Object.values(config.credentialRefs)])
    }
  }

  const gateway: CliGateway = {
    get version() { return version },
    resolve,
    async probeVersion(signal) {
      const response = await gateway.run(['version', '--json'], signal === undefined ? {} : { signal })
      const capabilities = await gateway.run(['capabilities', '--json'], signal === undefined ? {} : { signal })
      if ([response, capabilities].some(envelope => !envelope.success || envelope.status !== 'completed' || envelope.retryable
        || envelope.error !== undefined || envelope.error_details !== undefined || (envelope.next_actions?.length ?? 0) > 0)) {
        throw new Error('md2wechat compatibility probes did not report ready')
      }
      return response.data!.version as string
    },
    async run(argv, options = {}) {
      const control = createAbortControl(options.signal, options.timeoutMs ?? config.foregroundTimeoutMs)
      const secrets = options.secrets ?? []
      try {
        const response = await runWithRetries(ctx, config, resolve, argv, options, control.signal)
        if (argv[0] === 'version' && response.success && response.status === 'completed') version = response.data!.version as string
        return response
      } catch (error) {
        if (argv[0] === 'version') version = undefined
        throw sanitizeError(control.classify(error), secrets)
      } finally {
        control.dispose()
      }
    },
  }
  return gateway
}

/** Fresh version identity for signed previews; injected gateways may provide a known identity. */
export async function probeCliVersion(gateway: CliGateway | undefined, signal?: AbortSignal): Promise<string> {
  return gateway?.probeVersion === undefined ? gateway?.version ?? 'unknown' : gateway.probeVersion(signal)
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
  await waitForBeforeSpawn(options.beforeSpawn, signal)

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

async function waitForBeforeSpawn(
  beforeSpawn: CliRunOptions['beforeSpawn'],
  signal: AbortSignal,
): Promise<void> {
  if (beforeSpawn === undefined) return
  signal.throwIfAborted()
  const callback = Promise.resolve().then(() => beforeSpawn(signal))
  let onAbort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => { reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try {
    await Promise.race([callback, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
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
