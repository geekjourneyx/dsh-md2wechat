import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isProcessAlive,
  runBounded,
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
