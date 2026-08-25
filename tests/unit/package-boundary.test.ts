import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const checker = new URL('../../scripts/check-boundaries.mjs', import.meta.url)

function check(root: string) {
  return spawnSync(process.execPath, [checker.pathname, root], { encoding: 'utf8' })
}

async function temporaryRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-md2wechat-boundary-'))
}

describe('repository boundary', () => {
  it.each(['main.go', 'go.mod', 'md2wechat', 'md2wechat-darwin-arm64'])('rejects %s', async (name) => {
    const root = await temporaryRoot()
    await writeFile(join(root, name), '')
    expect(check(root).status).toBe(1)
  })

  it('accepts the plugin-only allowlist', async () => {
    const root = await temporaryRoot()
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src/index.ts'), '')
    await writeFile(join(root, 'package.json'), '{}\n')
    expect(check(root).status).toBe(0)
  })

  it('ignores an untracked orchestration workspace', async () => {
    const root = await temporaryRoot()
    await mkdir(join(root, '.superpowers'))
    await writeFile(join(root, '.superpowers', 'task.md'), '')
    await writeFile(join(root, '.gitignore'), '.superpowers/\n')
    execFileSync('git', ['init', '--quiet'], { cwd: root })
    expect(check(root).status).toBe(0)
  })

  it('rejects a tracked orchestration workspace', async () => {
    const root = await temporaryRoot()
    await mkdir(join(root, '.superpowers'))
    await writeFile(join(root, '.superpowers', 'task.md'), '')
    execFileSync('git', ['init', '--quiet'], { cwd: root })
    execFileSync('git', ['add', '.superpowers/task.md'], { cwd: root })
    expect(check(root).status).toBe(1)
  })

  it('rejects an orchestration workspace included in a package archive', async () => {
    const root = await temporaryRoot()
    const packageRoot = join(root, 'package')
    await mkdir(join(packageRoot, '.superpowers'), { recursive: true })
    await writeFile(join(packageRoot, '.superpowers', 'task.md'), '')
    const archive = join(root, 'plugin.tgz')
    execFileSync('tar', ['-czf', archive, 'package'], {
      cwd: root,
      env: { ...process.env, LC_ALL: 'C' },
    })
    const result = check(archive)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('package/.superpowers/task.md')
  })
})
