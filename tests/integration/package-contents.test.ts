import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, '../..')
const harnessRoot = resolve(repositoryRoot, '../../web/deepseek-harness')
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function packedFixture(): Promise<{ archive: string; packageRoot: string; entries: string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-md2wechat-package-'))
  temporaryRoots.push(root)
  await exec('pnpm', ['pack', '--pack-destination', root], { cwd: repositoryRoot, timeout: 120_000 })
  const archiveName = (await readdir(root)).find(name => name.endsWith('.tgz'))
  if (archiveName === undefined) throw new Error('pnpm pack did not create an archive')
  const archive = join(root, archiveName)
  const { stdout } = await exec('tar', ['-tzf', archive])
  const entries = stdout.trim().split('\n').filter(Boolean)
  const extracted = join(root, 'extracted')
  await mkdir(extracted)
  await exec('tar', ['-xzf', archive, '-C', extracted])
  await linkRuntimePackages(extracted)
  return { archive, packageRoot: join(extracted, 'package'), entries }
}

async function linkRuntimePackages(fixtureRoot: string): Promise<void> {
  const packages: Record<string, string> = {
    cordis: 'vendor/cordis',
    'dsh-credentials': 'packages/credentials/credentials',
    'dsh-fs': 'packages/fs/fs',
    'dsh-jobs': 'packages/jobs/jobs',
    'dsh-subprocess': 'packages/subprocess/subprocess',
    'dsh-system-prompt': 'packages/core/system-prompt',
    'dsh-tools': 'packages/core/tools',
    'dsh-user-approval': 'packages/interaction/user-approval',
    schemastery: 'vendor/schemastery',
  }
  const scope = join(fixtureRoot, 'node_modules', '@deepseek-ai')
  await mkdir(scope, { recursive: true })
  for (const [name, relative] of Object.entries(packages)) {
    await symlink(join(harnessRoot, relative), join(scope, name), 'dir')
  }
}

describe('packed plugin artifact', () => {
  it('contains only the built plugin entry, declarations, and one bundle patch', async () => {
    const fixture = await packedFixture()
    expect(fixture.entries).toContain('package/lib/index.js')
    expect(fixture.entries).toContain('package/lib/types/index.d.ts')
    expect(fixture.entries.filter(entry => entry === 'package/cordis.patch.yml')).toHaveLength(1)
    expect(fixture.entries).toContain('package/package.json')
    expect(fixture.entries.some(entry => /(?:^|\/)(?:tests?|fixtures?|artifacts?|node_modules|\.superpowers|md2wechat-skill|cmd)(?:\/|$)/u.test(entry))).toBe(false)
    expect(fixture.entries.some(entry => /(?:\.go|go\.mod|go\.sum|md2wechat(?:\.exe)?|\.dylib|\.so|\.dll)$/u.test(entry))).toBe(false)

    const manifest = JSON.parse(await readFile(join(fixture.packageRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>
      files: string[]
      dsh: { bundle: { patch: string } }
    }
    expect(manifest.exports['./cordis.patch.yml']).toBe('./cordis.patch.yml')
    expect(manifest.files.filter(file => file === 'cordis.patch.yml')).toHaveLength(1)
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
  }, 120_000)

  it('imports and completes one lifecycle from the extracted archive under plain Node', async () => {
    const fixture = await packedFixture()
    const entry = join(fixture.packageRoot, 'lib', 'index.js')
    const script = `
      import { pathToFileURL } from 'node:url'
      import { Context } from '@deepseek-ai/cordis'
      import ToolRuntime from '@deepseek-ai/dsh-tools'
      import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
      const plugin = await import(pathToFileURL(${JSON.stringify(entry)}).href)
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
      await ctx.plugin(ToolRuntime, { mode: 'native' })
      const calls = []
      const read = text => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
      ctx.provide('subprocess', {
        resolveExecutable: async path => path,
        spawn(spec) {
          const argv = spec.argv.slice(1); calls.push(argv)
          const commands = ['inspect','advise','preview','config','write','humanize','title','upload_image','download_and_upload','generate_image','generate_cover','generate_infographic','create_draft','providers','capabilities','version']
          const data = argv[0] === 'version' ? { version: '3.3.0' } : { commands }
          const text = JSON.stringify({ success: true, code: 'OK', message: 'completed', schema_version: 'v1', status: 'completed', retryable: false, data })
          return { done: Promise.resolve({ exitCode: 0, signal: null }), waitForExit: async () => {}, collected: { stdout: read(text), stderr: read('') } }
        },
      })
      ctx.provide('fs', {})
      ctx.provide('approval', { request: async () => 'rejected' })
      ctx.provide('credentials', { resolve: async () => undefined })
      ctx.provide('jobs', { start() { throw new Error('not used') }, get() { return undefined } })
      const names = ['md2wechat_doctor','md2wechat_start_article','md2wechat_improve_article','md2wechat_plan_images','md2wechat_preview','md2wechat_export','md2wechat_create_draft','md2wechat_generate_images']
      const fiber = await ctx.plugin(plugin, { binaryPath: '/opt/md2wechat', stateDir: '/var/lib/dsh-md2wechat-packed-test', safeReadRetries: 0 })
      if (plugin.name !== 'dsh-md2wechat' || names.some(name => ctx.tools.get(name) === undefined)) throw new Error('packed plugin did not register expected tools')
      const sections = (await ctx.systemPrompt.assemble()).sections.filter(section => section.name === 'tool:md2wechat')
      if (sections.length !== 1 || calls.length !== 2) throw new Error('packed plugin did not activate exactly once')
      await fiber.dispose()
      if (names.some(name => ctx.tools.get(name) !== undefined)) throw new Error('packed plugin did not dispose tools')
      if ((await ctx.systemPrompt.assemble()).sections.some(section => section.name === 'tool:md2wechat')) throw new Error('packed plugin did not dispose prompt')
    `
    await expect(exec(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: dirname(fixture.packageRoot),
      timeout: 30_000,
    })).resolves.toMatchObject({ stderr: '' })
  }, 120_000)
})
