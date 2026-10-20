import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Config, resolveConfig } from '../../src/config.ts'
import { createCliGateway } from '../../src/cli/gateway.ts'

const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('defaults to host PATH without requiring an absolute path override', () => {
  expect(resolveConfig({}).binaryPath).toBe('md2wechat')
  expect(resolveConfig(Config({})).binaryPath).toBe('md2wechat')
  expect(resolveConfig({ binaryPath: 'md2wechat' }).binaryPath).toBe('md2wechat')
})
it.each(['./md2wechat', '.tools/md2wechat-330', '../bin/md2wechat', 'another-command'])('rejects ambiguous relative executable %s', binaryPath => {
  expect(() => resolveConfig({ binaryPath })).toThrow('absolute')
})
it('resolves the host PATH command through the official subprocess runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'md2wechat-path-')); roots.push(root)
  const executable = resolve('tests/fixtures/fake-md2wechat.mjs')
  await symlink(executable, join(root, 'md2wechat'))
  vi.stubEnv('PATH', `${root}:${process.env.PATH}`)
  const context = new Context(); const fiber = await context.plugin(LocalSubprocessRuntime)
  try { expect(await realpath(await createCliGateway(context, resolveConfig({})).resolve())).toBe(await realpath(executable)) }
  finally { await fiber.dispose() }
})
it('does not fall back from an explicit failed path and gives non-secret setup guidance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'md2wechat-no-fallback-')); roots.push(root)
  await symlink(resolve('tests/fixtures/fake-md2wechat.mjs'), join(root, 'md2wechat'))
  vi.stubEnv('PATH', `${root}:${process.env.PATH}`)
  const context = new Context(); const fiber = await context.plugin(LocalSubprocessRuntime)
  try {
    const error = await createCliGateway(context, resolveConfig({ binaryPath: '/unavailable/private-needle', credentialRefs: { MD2WECHAT_API_KEY: 'ref-needle', WECHAT_APPID: 'ref-needle', WECHAT_SECRET: 'ref-needle', IMAGE_API_KEY: 'ref-needle' } })).resolve().catch(e => e as Error)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('MD2WECHAT_BINARY_PATH')
    expect(error.message).toContain('executable file')
    expect(error.message).toContain('restart')
    expect(error.message).not.toContain('needle')
  } finally { await fiber.dispose() }
})

it('rejects an install directory rather than attempting to execute it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'md2wechat-directory-')); roots.push(root)
  const context = new Context(); const fiber = await context.plugin(LocalSubprocessRuntime)
  try { await expect(createCliGateway(context, resolveConfig({ binaryPath: root })).resolve()).rejects.toThrow('not its install directory') }
  finally { await fiber.dispose() }
})
