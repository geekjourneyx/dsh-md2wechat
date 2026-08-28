import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isProcessAlive,
  runBounded,
  terminateProcessTree,
} from '../../scripts/installed-acceptance-support.mjs'

const roots: string[] = []
const fixturePids: number[] = []

afterEach(async () => {
  for (const pid of fixturePids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('installed acceptance child timeout', () => {
  it('starts Windows tree cleanup with exact arguments and a scrubbed environment', async () => {
    const calls: Array<{ command: string, args: string[], options: Record<string, unknown> }> = []
    const spawnProcess = (command: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ command, args, options })
      const listeners = new Map<string, (value: unknown) => void>()
      queueMicrotask(() => listeners.get('exit')?.(0))
      return {
        once: (event: string, listener: (value: unknown) => void) => {
          listeners.set(event, listener)
        },
        kill: () => true,
      }
    }
    const environment = {
      PATH: '%SystemRoot%\\System32;;relative',
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      PATHEXT: '.COM;.EXE',
      NPM_TOKEN: 'child-npm-secret',
      DEEPSEEK_API_KEY: 'child-provider-secret',
      HTTPS_PROXY: 'http://child-proxy.invalid',
    }
    process.env.NPM_TOKEN = 'ambient-npm-secret'
    process.env.DEEPSEEK_API_KEY = 'ambient-provider-secret'
    process.env.HTTPS_PROXY = 'http://ambient-proxy.invalid'
    try {
      await terminateProcessTree(
        { pid: 2_147_483_646 } as never,
        Promise.resolve({ code: 0, signal: null }),
        100,
        { platform: 'win32', spawnProcess: spawnProcess as never, environment },
      )
    } finally {
      delete process.env.NPM_TOKEN
      delete process.env.DEEPSEEK_API_KEY
      delete process.env.HTTPS_PROXY
    }

    expect(calls).toEqual([{
      command: 'C:\\Windows\\System32\\taskkill.exe',
      args: ['/PID', '2147483646', '/T', '/F'],
      options: {
        env: {
          SystemRoot: 'C:\\Windows',
          WINDIR: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        },
        stdio: 'ignore',
        windowsHide: true,
      },
    }])
    expect(calls[0]?.options.env).not.toHaveProperty('NPM_TOKEN')
    expect(calls[0]?.options.env).not.toHaveProperty('DEEPSEEK_API_KEY')
    expect(calls[0]?.options.env).not.toHaveProperty('HTTPS_PROXY')
  })

  it('locates Windows tree cleanup from ComSpec when system roots are missing or relative', async () => {
    const calls: Array<{ command: string, options: Record<string, unknown> }> = []
    const spawnProcess = (command: string, _args: string[], options: Record<string, unknown>) => {
      calls.push({ command, options })
      const listeners = new Map<string, (value: unknown) => void>()
      queueMicrotask(() => listeners.get('exit')?.(0))
      return {
        once: (event: string, listener: (value: unknown) => void) => listeners.set(event, listener),
        kill: () => true,
      }
    }

    await terminateProcessTree(
      { pid: 2_147_483_645 } as never,
      Promise.resolve({ code: 0, signal: null }),
      100,
      {
        platform: 'win32',
        spawnProcess: spawnProcess as never,
        environment: {
          PATH: '%SystemRoot%\\System32;relative',
          WINDIR: 'relative',
          ComSpec: 'D:\\Windows\\System32\\cmd.exe',
          NPM_TOKEN: 'secret',
        },
      },
    )

    expect(calls).toEqual([{
      command: 'D:\\Windows\\System32\\taskkill.exe',
      options: {
        env: { ComSpec: 'D:\\Windows\\System32\\cmd.exe' },
        stdio: 'ignore',
        windowsHide: true,
      },
    }])
  })

  it('fails clearly when Windows supplies no absolute cleanup executable anchor', async () => {
    await expect(terminateProcessTree(
      { pid: 2_147_483_644 } as never,
      Promise.resolve({ code: 0, signal: null }),
      100,
      {
        platform: 'win32',
        spawnProcess: (() => { throw new Error('must not spawn') }) as never,
        environment: {
          PATH: '%SystemRoot%\\System32;relative',
          SystemRoot: '%SystemRoot%',
          WINDIR: 'relative',
          ComSpec: 'cmd.exe',
        },
      },
    )).rejects.toThrow('cannot locate Windows taskkill')
  })

  it('kills and reaps a hung child process tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-md2wechat-hung-'))
    roots.push(root)
    const pidFile = join(root, 'pids.json')
    const fixture = `
      const { spawn } = require('node:child_process')
      const { writeFileSync } = require('node:fs')
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' })
      writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]))
      setInterval(() => {}, 1000)
    `

    await expect(runBounded(process.execPath, ['-e', fixture], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 1_000,
      killGraceMs: 100,
      label: 'hung fixture',
    })).rejects.toThrow('timed out')

    const pids = JSON.parse(await readFile(pidFile, 'utf8')) as number[]
    fixturePids.push(...pids)
    await expect.poll(() => pids.map(isProcessAlive), { timeout: 2_000 }).toEqual([false, false])
  })
})
