import { sandboxPolicyFixture } from '../fixtures/sandbox-policy.ts'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, '../..')
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
  await symlink(join(repositoryRoot, 'node_modules'), join(fixtureRoot, 'node_modules'), 'dir')
}

describe('packed plugin artifact', () => {
  it('contains the built host and client entries, generated Remote contracts, and one bundle patch', async () => {
    const fixture = await packedFixture()
    // The host loads this bundle in a browser, where Node's process is absent.
    let clientExports: unknown
    const require = createRequire(import.meta.url)
    runInNewContext(await readFile(join(fixture.packageRoot, 'lib/client.js'), 'utf8'), {
      window: { __ModuleLoader__: { load(registration: { factory: (load: typeof require) => unknown }) {
        clientExports = registration.factory(require)
      } } },
    })
    expect(clientExports).toHaveProperty('apply')
    expect(fixture.entries).toContain('package/lib/index.js')
    expect(fixture.entries).toContain('package/lib/types/index.d.ts')
    for (const entry of ['client.js', 'typert.host.js', 'typert.host.d.ts', 'typert.remote-client.js', 'typert.remote-client.d.ts']) {
      expect(fixture.entries).toContain(`package/lib/${entry}`)
    }
    expect(fixture.entries.filter(entry => entry === 'package/cordis.patch.yml')).toHaveLength(1)
    for (const document of ['README.md', 'CHANGELOG.md', 'LICENSE', 'assets/readme/readme-hero.webp']) {
      expect(fixture.entries.filter(entry => entry === `package/${document}`)).toHaveLength(1)
    }
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

  it('ships release documents with the supported install path and product boundaries', async () => {
    const fixture = await packedFixture()
    const readme = await readFile(join(fixture.packageRoot, 'README.md'), 'utf8')
    const changelog = await readFile(join(fixture.packageRoot, 'CHANGELOG.md'), 'utf8')
    const license = await readFile(join(fixture.packageRoot, 'LICENSE'), 'utf8')

    expect(readme.startsWith('# dsh-md2wechat\n')).toBe(true)
    expect(readme).toContain('dsh plugin --profile web add https://github.com/geekjourneyx/dsh-md2wechat/releases/download/v1.0.0/geekjourneyx-dsh-md2wechat-1.0.0.tgz')
    expect(readme).toContain('支持 `v1` JSON 协议')
    expect(readme).toContain('插件及其发布包不包含、也不会自动安装或升级 md2wechat')
    expect(readme).toContain('不发布、不群发')
    expect(readme).toContain('当前助手没有其他生图能力')
    expect(readme).toContain('npm install -g @geekjourneyx/md2wechat')
    expect(readme).not.toMatch(/(?:^|\n)npm publish\b/u)
    expect(readme).not.toMatch(/\/Users\/|md2wechat-(?:darwin|linux|windows)/u)
    for (const name of ['feature-wall-01.png', 'feature-wall-02.png', 'feature-wall-03.png']) {
      expect(readme).toContain(`src="./assets/${name}"`)
      const image = await readFile(join(fixture.packageRoot, 'assets', name))
      expect(image.subarray(1, 4).toString()).toBe('PNG')
      expect(image.byteLength).toBeLessThan(1_000_000)
    }
    expect(changelog.match(/^## 1\.0\.0\b/gmu)).toHaveLength(1)
    expect(changelog.match(/^## \d/gmu)).toHaveLength(5)
    expect(changelog).toContain('## 2.0.0-rc.4 - 2026-10-29')
    expect(license.trimStart().startsWith('GNU AFFERO GENERAL PUBLIC LICENSE\n')).toBe(true)
    expect(license).toContain('Version 3, 19 November 2007')
    expect(readme).toContain('[AGPL-3.0 许可证](./LICENSE)')
    const manifest = JSON.parse(await readFile(join(fixture.packageRoot, 'package.json'), 'utf8'))
    expect(manifest.license).toBe('AGPL-3.0-only')
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
      ctx.provide('sandboxPolicy', (${sandboxPolicyFixture.toString()})(process.cwd()))
      ctx.provide('approval', { request: async () => 'rejected' })
      ctx.provide('credentials', { resolve: async () => undefined })
      ctx.provide('jobs', { start() { throw new Error('not used') }, get() { return undefined } })
      const names = ['md2wechat_doctor','md2wechat_start_article','md2wechat_improve_article','md2wechat_plan_images','md2wechat_preview','md2wechat_export','md2wechat_create_draft','md2wechat_generate_images','md2wechat_open_workspace','md2wechat_propose_changes','md2wechat_import_creator_image','md2wechat_generate_creator_images']
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
