import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const script = resolve('scripts/release.mjs')
const roots: string[] = []
function fixture(version = '2.0.0-rc.1') {
  const root = mkdtempSync(join(tmpdir(), 'release-test-'))
  roots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@geekjourneyx/dsh-md2wechat', version, scripts: { build: 'tsc' } }))
  return root
}
function run(root: string, ...args: string[]) {
  return execFileSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('validates exact SemVer and distinguishes prerelease from stable', () => {
  expect(JSON.parse(run(fixture(), 'validate', 'v2.0.0-rc.1'))).toEqual({ version: '2.0.0-rc.1', tag: 'v2.0.0-rc.1', prerelease: true })
  expect(JSON.parse(run(fixture('2.0.0'), 'validate', 'v2.0.0')).prerelease).toBe(false)
})
it.each(['v1.0.0', '2.0.0-rc.1', 'v02.0.0', 'v2.0.0-01', 'v2.0.0+build', 'v2.0.0\n'])('rejects mismatched or unsafe release tag %j', tag => {
  expect(() => run(fixture(), 'validate', tag)).toThrow()
})
it('rejects malformed package version even when tag matches', () => {
  expect(() => run(fixture('02.0.0'), 'validate', 'v02.0.0')).toThrow()
})
it('checks real packed manifest and files before producing checksum assets', () => {
  const root = fixture()
  const pkg = join(root, 'package')
  mkdirSync(join(pkg, 'lib'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), readFileSync(join(root, 'package.json')))
  for (const file of ['index.js', 'client.js', 'typert.host.js', 'typert.remote-client.js']) writeFileSync(join(pkg, 'lib', file), '// built')
  writeFileSync(join(pkg, 'cordis.patch.yml'), '[]')
  mkdirSync(join(pkg, 'assets'))
  for (const name of ['feature-wall-01.png', 'feature-wall-02.png', 'feature-wall-03.png']) writeFileSync(join(pkg, 'assets', name), 'fixture image')
  const archive = join(root, 'input.tgz')
  execFileSync('tar', ['-czf', archive, '-C', root, 'package'])
  run(root, 'artifact', 'v2.0.0-rc.1', archive, join(root, 'output'))
  const checksums = readFileSync(join(root, 'output', 'SHA256SUMS'), 'utf8')
  expect(checksums).toMatch(/^[a-f0-9]{64}  geekjourneyx-dsh-md2wechat-2\.0\.0-rc\.1\.tgz\n$/u)
  execFileSync('sha256sum', ['--check', 'SHA256SUMS'], { cwd: join(root, 'output') })
  expect(() => run(root, 'artifact', 'v2.0.0-rc.1', archive, join(root, 'output'))).toThrow()
  writeFileSync(join(pkg, 'assets', 'unexpected.png'), 'not allowed')
  execFileSync('tar', ['-czf', archive, '-C', root, 'package'])
  expect(() => run(root, 'artifact', 'v2.0.0-rc.1', archive, join(root, 'unexpected'))).toThrow()
  rmSync(join(pkg, 'assets', 'unexpected.png'))
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@geekjourneyx/dsh-md2wechat', version: '2.0.0-rc.1', scripts: { postinstall: 'tsc' } }))
  execFileSync('tar', ['-czf', archive, '-C', root, 'package'])
  expect(() => run(root, 'artifact', 'v2.0.0-rc.1', archive, join(root, 'lifecycle'))).toThrow()
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@geekjourneyx/dsh-md2wechat', version: '1.0.0' }))
  execFileSync('tar', ['-czf', archive, '-C', root, 'package'])
  expect(() => run(root, 'artifact', 'v2.0.0-rc.1', archive, join(root, 'wrong'))).toThrow()
})
it('has a tag-only release workflow with read-only build and isolated publishing', () => {
  const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8')
  expect(workflow).toContain("tags: ['v*']")
  expect(workflow).not.toContain('workflow_dispatch:')
  expect(workflow).toContain('contents: read')
  expect(workflow.match(/contents: write/gu)).toHaveLength(1)
  expect(workflow).toContain('git merge-base --is-ancestor')
  expect(workflow).toContain('pnpm test')
  expect(workflow).toContain('sha256sum --check SHA256SUMS')
  expect(workflow).toContain('gh release create')
  expect(workflow).toContain('--draft')
  expect(workflow).not.toContain('--clobber')
  expect(workflow).not.toContain('npm publish')
})
it('keeps runtime and tool schema version identities aligned with the package', async () => {
  const { PLUGIN_VERSION } = await import('../../src/version.ts')
  const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
  expect(PLUGIN_VERSION).toBe(manifest.version)
  for (const name of ['doctor', 'start-article', 'improve-article', 'plan-images', 'generate-images', 'preview', 'export', 'create-draft']) {
    expect(readFileSync(resolve(`src/tools/${name}.ts`), 'utf8')).toContain("pluginVersion: { type: 'string', const: PLUGIN_VERSION")
  }
})
