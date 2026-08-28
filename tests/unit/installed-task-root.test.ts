import { mkdtemp, mkdir, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTaskRootGuard } from '../../scripts/installed-acceptance-support.mjs'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('installed acceptance task-root guard', () => {
  it('rejects a task-root symlink without touching its target', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-md2wechat-root-'))
    roots.push(fixture)
    const target = join(fixture, 'target')
    const link = join(fixture, 'link')
    await mkdir(target)
    await symlink(target, link)

    await expect(createTaskRootGuard(link, {
      forbiddenRoots: [],
      platformTempRoot: join(fixture, 'not-platform-temp'),
    })).rejects.toThrow('must not be a symbolic link')
  })

  it('rejects task-root replacement before recursive cleanup', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-md2wechat-replace-'))
    roots.push(fixture)
    const root = join(fixture, 'root')
    const original = join(fixture, 'original')
    const replacement = join(fixture, 'replacement')
    await mkdir(root)
    await mkdir(replacement)
    const guard = await createTaskRootGuard(root, {
      forbiddenRoots: [],
      platformTempRoot: join(fixture, 'not-platform-temp'),
    })
    await rename(root, original)
    await symlink(replacement, root)

    await expect(guard.assertCurrent()).rejects.toThrow('identity changed')
  })
})
