import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, '../..')

describe('installed acceptance harness', () => {
  it('fails loud before doing work when absolute acceptance inputs are absent', async () => {
    const execution = exec(process.execPath, ['scripts/installed-acceptance.mjs'], {
      cwd: repositoryRoot,
      env: { PATH: process.env.PATH ?? '' },
      timeout: 10_000,
    })

    await expect(execution).rejects.toMatchObject({
      stderr: expect.stringContaining('DSH_CHECKOUT must be an absolute path'),
    })
  })
})
