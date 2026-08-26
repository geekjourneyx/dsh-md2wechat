import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '../../../../web/deepseek-harness/vendor/cordis/src/index.ts'
import type { Fiber } from '../../../../web/deepseek-harness/vendor/cordis/src/index.ts'
import LocalSubprocessRuntime from '../../../../web/deepseek-harness/packages/subprocess/subprocess-local/src/index.ts'
import type { ResolvedConfig } from '../../src/config.ts'
import { createCliGateway, REQUIRED_CLI_COMMANDS } from '../../src/cli/gateway.ts'

const fakeCli = new URL('../fixtures/fake-md2wechat.mjs', import.meta.url).pathname
const baseConfig: ResolvedConfig = {
  binaryPath: fakeCli,
  artifactsDir: '.dsh/md2wechat',
  stateDir: '/var/lib/dsh/plugins/dsh-md2wechat',
  layoutBaseUrl: 'https://www.md2wechat.cn',
  previewTheme: 'default',
  previewFontSize: 'medium',
  previewBackgroundType: 'none',
  enableWechatWriteTools: true,
  enableFallbackImageTool: true,
  safeReadRetries: 1,
  safeReadRetryDelayMs: 1,
  foregroundTimeoutMs: 120_000,
  imageJobTimeoutMs: 900_000,
  credentialRefs: {},
}

const context = new Context()
let subprocessFiber: Fiber

beforeAll(async () => {
  subprocessFiber = await context.plugin(LocalSubprocessRuntime)
})

afterAll(async () => {
  await subprocessFiber.dispose()
})

function gateway(overrides: Partial<ResolvedConfig> = {}) {
  return createCliGateway(context, { ...baseConfig, ...overrides })
}

async function attempts(counterFile: string): Promise<number> {
  return (await readFile(counterFile, 'utf8')).trim().split('\n').length
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function waitForPids(pidFile: string, timeoutMs = 1_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const values = (await readFile(pidFile, 'utf8')).trim().split('\n').map(Number)
      if (values.length >= 2) return values
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('fake CLI did not publish process ids')
}

describe('CLI gateway', () => {
  it('resolves only the configured executable', async () => {
    await expect(gateway().resolve()).resolves.toBe(await realpath(fakeCli))
  })

  it('classifies direct resolution failures without exposing configured values', async () => {
    const missingPath = join(tmpdir(), 'needle-private-md2wechat')
    const unresolved = gateway({
      binaryPath: missingPath,
      credentialRefs: { WECHAT_SECRET: 'needle-secret-reference' },
    })
    const error = await unresolved.resolve().catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('configured md2wechat executable could not be resolved')
    expect((error as Error).message).not.toContain('needle')

    await expect(unresolved.resolve(AbortSignal.abort('needle-cancel-reason')))
      .rejects.toThrow('resolution cancelled')
  })

  it('runs the version and complete capability probes', async () => {
    await expect(gateway().run(['version', '--json'])).resolves.toMatchObject({ success: true })
    await expect(gateway().run(['capabilities', '--json'])).resolves.toMatchObject({
      data: { commands: expect.any(Array) },
    })
  })

  it('exports the one complete required-command list used by capability validation', async () => {
    expect(REQUIRED_CLI_COMMANDS).toEqual([
      'inspect', 'advise', 'preview', 'config', 'write', 'humanize', 'title',
      'upload_image', 'download_and_upload', 'generate_image', 'generate_cover',
      'generate_infographic', 'create_draft', 'providers', 'capabilities', 'version',
    ])
    await expect(gateway().run(['capabilities', '--json'], {
      env: { FAKE_MD2WECHAT_BEHAVIOR: 'missing-capability' },
    })).rejects.toThrow('version')
  })

  it.each([
    ['malformed', 'JSON'],
    ['multiple-json', 'JSON'],
    ['oversize', 'output limit'],
    ['signal', 'SIGTERM'],
    ['version-mismatch', '3.3.0'],
  ])('rejects %s process output', async (behavior, message) => {
    await expect(gateway({ safeReadRetries: 0 }).run(['version', '--json'], {
      env: { FAKE_MD2WECHAT_BEHAVIOR: behavior },
    })).rejects.toThrow(message)
  })

  it('times out and waits for the whole fixture process tree to exit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-md2wechat-timeout-'))
    const pidFile = join(directory, 'pids')
    const running = gateway().run(['version', '--json'], {
      env: {
        FAKE_MD2WECHAT_BEHAVIOR: 'sleep',
        FAKE_MD2WECHAT_PID_FILE: pidFile,
      },
      timeoutMs: 1_000,
    })
    const rejection = running.then(
      () => undefined,
      (error: unknown) => error,
    )
    const pids = await waitForPids(pidFile, 800)
    expect(await rejection).toMatchObject({ message: expect.stringContaining('timed out') })
    expect(pids.every(pid => !processExists(pid))).toBe(true)
  })

  it('cancels and waits for the whole fixture process tree to exit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-md2wechat-cancel-'))
    const pidFile = join(directory, 'pids')
    const controller = new AbortController()
    const running = gateway().run(['version', '--json'], {
      env: {
        FAKE_MD2WECHAT_BEHAVIOR: 'sleep',
        FAKE_MD2WECHAT_PID_FILE: pidFile,
      },
      signal: controller.signal,
    })
    const pids = await waitForPids(pidFile)
    controller.abort()
    await expect(running).rejects.toThrow('cancelled')
    expect(pids.every(pid => !processExists(pid))).toBe(true)
  })

  it('redacts explicit secrets from process diagnostics', async () => {
    await expect(gateway({ safeReadRetries: 0 }).run(['version', '--json'], {
      env: {
        FAKE_MD2WECHAT_BEHAVIOR: 'stderr-secret',
        WECHAT_SECRET: 'needle',
      },
      secrets: ['needle'],
    })).rejects.not.toThrow('needle')
  })

  it.each([
    ['version', '--json'],
    ['capabilities', '--json'],
    ['providers', 'list', '--json'],
    ['providers', 'show', 'openai', '--json'],
    ['config', 'show', '--json'],
    ['config', 'validate', '--json'],
    ['config', 'wechat-accounts', '--json'],
  ])('retries the approved read-only call %j', async (...argv) => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-md2wechat-retry-'))
    const counterFile = join(directory, 'attempts')
    await expect(gateway().run(argv, {
      env: {
        FAKE_MD2WECHAT_BEHAVIOR: 'retry-once',
        FAKE_MD2WECHAT_COUNTER_FILE: counterFile,
      },
    })).resolves.toMatchObject({ success: true })
    expect(await attempts(counterFile)).toBe(2)
  })

  it.each([
    ['inspect', '--json'],
    ['advise', '--json'],
    ['preview', '--json'],
    ['write', '--json'],
    ['humanize', '--json'],
    ['title', '--json'],
    ['upload_image', '--json'],
    ['download_and_upload', '--json'],
    ['generate_image', '--json'],
    ['generate_cover', '--json'],
    ['generate_infographic', '--json'],
    ['create_draft', '--json'],
    ['providers', 'delete', '--json'],
    ['config', 'set', '--json'],
  ])('does not retry the external or write call %j', async (...argv) => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-md2wechat-no-retry-'))
    const counterFile = join(directory, 'attempts')
    await expect(gateway().run(argv, {
      env: {
        FAKE_MD2WECHAT_BEHAVIOR: 'retry-once',
        FAKE_MD2WECHAT_COUNTER_FILE: counterFile,
      },
    })).resolves.toMatchObject({ success: false, retryable: true })
    expect(await attempts(counterFile)).toBe(1)
  })

  it('passes stdin and cwd without invoking a shell', async () => {
    await expect(gateway().run(['inspect', '--json'], {
      env: { FAKE_MD2WECHAT_BEHAVIOR: 'stdin' },
      stdin: 'article',
    })).resolves.toMatchObject({ data: { stdin: 'article' } })

    const cwd = await mkdtemp(join(tmpdir(), 'dsh-md2wechat-cwd-'))
    await expect(gateway().run(['inspect', '--json'], {
      cwd,
      env: { FAKE_MD2WECHAT_BEHAVIOR: 'cwd' },
    })).resolves.toMatchObject({ data: { cwd: await realpath(cwd) } })
  })

  it('awaits beforeSpawn before starting the executable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-md2wechat-before-spawn-'))
    const markerFile = join(directory, 'ready')
    await expect(gateway().run(['version', '--json'], {
      env: {
        FAKE_MD2WECHAT_BEHAVIOR: 'require-marker',
        FAKE_MD2WECHAT_MARKER_FILE: markerFile,
      },
      beforeSpawn: async (signal) => {
        expect(signal.aborted).toBe(false)
        await writeFile(markerFile, 'ready\n')
      },
    })).resolves.toMatchObject({ success: true })
  })

  it.each([
    ['timed out', undefined],
    ['cancelled', new AbortController()],
  ])('interrupts a never-settling beforeSpawn callback when the run is %s', async (classification, controller) => {
    const startedAt = Date.now()
    const running = gateway().run(['version', '--json'], {
      timeoutMs: classification === 'timed out' ? 25 : 2_000,
      ...(controller === undefined ? {} : { signal: controller.signal }),
      beforeSpawn: () => new Promise<void>(() => {}),
    })
    if (controller !== undefined) setTimeout(() => { controller.abort() }, 25)
    const bounded = Promise.race([
      running,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => { reject(new Error('beforeSpawn stayed pending')) }, 500)
      }),
    ])
    await expect(bounded).rejects.toThrow(classification)
    expect(Date.now() - startedAt).toBeLessThan(500)
  })

  it('handles a beforeSpawn rejection that arrives after cancellation', async () => {
    const callback = Promise.withResolvers<void>()
    const controller = new AbortController()
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown): void => { unhandled.push(error) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const running = gateway().run(['version', '--json'], {
        signal: controller.signal,
        beforeSpawn: () => callback.promise,
      })
      setTimeout(() => { controller.abort() }, 25)
      await expect(Promise.race([
        running,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => { reject(new Error('beforeSpawn stayed pending')) }, 500)
        }),
      ])).rejects.toThrow('cancelled')
      callback.reject(new Error('late callback failure'))
      await new Promise(resolve => setImmediate(resolve))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
