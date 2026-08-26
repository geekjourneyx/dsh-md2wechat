#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_NAME = '@geekjourneyx/dsh-md2wechat'
const PLUGIN_TOOLS = [
  'md2wechat_doctor',
  'md2wechat_start_article',
  'md2wechat_improve_article',
  'md2wechat_plan_images',
  'md2wechat_preview',
  'md2wechat_export',
  'md2wechat_create_draft',
  'md2wechat_generate_images',
]
const REQUIRED_COMMANDS = [
  'inspect',
  'advise',
  'preview',
  'config',
  'write',
  'humanize',
  'title',
  'upload_image',
  'download_and_upload',
  'generate_image',
  'generate_cover',
  'generate_infographic',
  'create_draft',
  'providers',
  'capabilities',
  'version',
]

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const inputs = validateInputs(process.env)
const paths = {
  dshHome: join(inputs.taskRoot, 'dsh-home'),
  workspace: join(inputs.taskRoot, 'workspace'),
  tarballs: join(inputs.taskRoot, 'tarballs'),
  logs: join(inputs.taskRoot, 'logs'),
  cliHome: join(inputs.taskRoot, 'cli-home'),
  stateDir: join(inputs.taskRoot, 'dsh-home', 'plugins', 'dsh-md2wechat'),
}

await main()

function validateInputs(environment) {
  const dshCheckout = absoluteInput(environment.DSH_CHECKOUT, 'DSH_CHECKOUT')
  const cliPath = absoluteInput(environment.MD2WECHAT_CLI, 'MD2WECHAT_CLI')
  const taskRoot = absoluteInput(environment.DSH_MD2WECHAT_TASK_ROOT, 'DSH_MD2WECHAT_TASK_ROOT')
  if (inside(taskRoot, tmpdir())) {
    throw new Error('DSH_MD2WECHAT_TASK_ROOT must stay outside the platform temporary directory')
  }
  return { dshCheckout, cliPath, taskRoot }
}

function absoluteInput(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`)
  }
  return resolve(value)
}

function inside(candidate, parent) {
  const offset = relative(resolve(parent), resolve(candidate))
  return offset === '' || (!offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset))
}

async function main() {
  await assertReadable(join(inputs.dshCheckout, 'apps', 'cli', 'package.json'))
  await assertExecutable(inputs.cliPath)
  await assertPrivateTaskRoot()
  await resetRunDirectories()

  const cli = await probeRealCli()
  await runLogged('plugin-build', 'pnpm', ['run', 'build'], { cwd: repositoryRoot })
  const archive = await packPlugin()
  await assertArchive(archive)

  await runLogged('dsh-build', 'pnpm', ['run', 'build'], { cwd: inputs.dshCheckout })
  const dshBin = join(inputs.dshCheckout, 'apps', 'cli', 'lib', 'bin.js')
  await assertReadable(dshBin)

  const fake = await writeFakeExecutables()
  const installation = await installArchive(dshBin, archive)
  const install = await verifyInstalled(dshBin, archive)
  const probe = await writeProbePlugin(fake)
  const web = await runWebAcceptance(dshBin, probe)
  const removal = await uninstallArchive(dshBin)

  const result = {
    archive,
    cli,
    install: { ...installation, ...install },
    web,
    removal,
    dshHome: paths.dshHome,
    workspace: paths.workspace,
    stateDir: paths.stateDir,
  }
  await writeFile(join(paths.logs, 'installed-acceptance-result.json'), `${JSON.stringify(result, undefined, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`)
}

async function assertReadable(path) {
  await access(path, fsConstants.R_OK)
}

async function assertExecutable(path) {
  await access(path, fsConstants.R_OK | fsConstants.X_OK)
  if (!(await stat(path)).isFile()) throw new Error(`MD2WECHAT_CLI is not a regular file: ${path}`)
}

async function assertPrivateTaskRoot() {
  const root = await stat(inputs.taskRoot)
  if (!root.isDirectory()) throw new Error('DSH_MD2WECHAT_TASK_ROOT must be a directory')
  if (process.platform !== 'win32' && (root.mode & 0o077) !== 0) {
    throw new Error('DSH_MD2WECHAT_TASK_ROOT must not grant group or other permissions')
  }
  if (inside(paths.stateDir, paths.workspace) || inside(paths.stateDir, tmpdir())) {
    throw new Error('plugin state root must be external to the workspace and platform temp')
  }
}

async function resetRunDirectories() {
  for (const path of [paths.dshHome, paths.workspace, paths.tarballs, paths.logs]) {
    if (!inside(path, inputs.taskRoot) || path === inputs.taskRoot) throw new Error(`refusing to reset unsafe task path: ${path}`)
    await rm(path, { recursive: true, force: true })
    await mkdir(path, { recursive: true, mode: 0o700 })
    await chmod(path, 0o700)
  }
  await mkdir(paths.cliHome, { recursive: true, mode: 0o700 })
  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 })
  await chmod(paths.cliHome, 0o700)
  await chmod(paths.stateDir, 0o700)
}

function controlledEnvironment(extra = {}) {
  return Object.fromEntries(Object.entries({
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? paths.cliHome,
    DSH_HOME: paths.dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_PERMISSION_MODE: 'workspace-write',
    MD2WECHAT_BINARY_PATH: extra.MD2WECHAT_BINARY_PATH ?? inputs.cliPath,
    ...extra,
  }).filter((entry) => entry[1] !== undefined))
}

async function probeRealCli() {
  const versionRun = await runLogged('cli-version', inputs.cliPath, ['version', '--json'], {
    cwd: paths.cliHome,
    env: controlledEnvironment({ HOME: paths.cliHome, DSH_HOME: undefined, MD2WECHAT_BINARY_PATH: undefined }),
  })
  const version = parseCompletedEnvelope(versionRun.stdout, 'version')
  if (version.data?.version !== '3.3.0') throw new Error(`real CLI version is not 3.3.0: ${JSON.stringify(version.data)}`)

  const capabilitiesRun = await runLogged('cli-capabilities', inputs.cliPath, ['capabilities', '--json'], {
    cwd: paths.cliHome,
    env: controlledEnvironment({ HOME: paths.cliHome, DSH_HOME: undefined, MD2WECHAT_BINARY_PATH: undefined }),
  })
  const capabilities = parseCompletedEnvelope(capabilitiesRun.stdout, 'capabilities')
  const commands = capabilities.data?.commands
  if (!Array.isArray(commands) || REQUIRED_COMMANDS.some(command => !commands.includes(command))) {
    throw new Error('real CLI capabilities omit a command required by the plugin')
  }
  return { version: version.data.version, commands }
}

function parseCompletedEnvelope(text, command) {
  let value
  try {
    value = JSON.parse(text.trim())
  } catch {
    throw new Error(`${command} did not return one JSON document`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || value.success !== true || value.status !== 'completed' || value.retryable !== false
    || value.schema_version !== 'v1' || value.error !== undefined || value.error_details !== undefined) {
    throw new Error(`${command} did not return a strict completed envelope`)
  }
  return value
}

async function packPlugin() {
  await runLogged('plugin-pack', 'pnpm', ['pack', '--pack-destination', paths.tarballs], { cwd: repositoryRoot })
  const archives = (await readdir(paths.tarballs)).filter(file => file.endsWith('.tgz'))
  if (archives.length !== 1) throw new Error(`expected one plugin archive, found ${archives.length}`)
  return join(paths.tarballs, archives[0])
}

async function assertArchive(archive) {
  const listing = await runLogged('archive-list', 'tar', ['-tzf', archive], { cwd: paths.tarballs })
  const entries = listing.stdout.trim().split('\n').filter(Boolean)
  for (const required of ['package/package.json', 'package/cordis.patch.yml', 'package/lib/index.js']) {
    if (!entries.includes(required)) throw new Error(`plugin archive omits ${required}`)
  }
  const forbidden = entries.find(entry => /(?:^|\/)(?:src|tests?|scripts|fixtures?|artifacts?|node_modules|\.superpowers|md2wechat-skill|cmd)(?:\/|$)|(?:\.go|go\.mod|go\.sum|md2wechat(?:\.exe)?)$/u.test(entry))
  if (forbidden !== undefined) throw new Error(`plugin archive contains forbidden entry ${forbidden}`)
}

async function writeFakeExecutables() {
  const directory = join(inputs.taskRoot, 'fake-cli')
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const log = join(paths.logs, 'fake-cli-calls.jsonl')
  const executables = {}
  for (const behavior of ['normal', 'malformed', 'wrong-version', 'missing-capability']) {
    const path = join(directory, `md2wechat-${behavior}`)
    await writeFile(path, fakeCliSource(behavior, log), { mode: 0o700 })
    await chmod(path, 0o700)
    executables[behavior] = path
  }
  return { ...executables, log }
}

function fakeCliSource(behavior, callLog) {
  return `#!${process.execPath}
import { appendFileSync } from 'node:fs'
const argv = process.argv.slice(2)
appendFileSync(${JSON.stringify(callLog)}, JSON.stringify({ behavior: ${JSON.stringify(behavior)}, argv }) + '\\n')
const commands = ${JSON.stringify(REQUIRED_COMMANDS)}
const completed = data => ({ success: true, code: 'OK', message: 'completed', schema_version: 'v1', status: 'completed', retryable: false, data })
if (${JSON.stringify(behavior)} === 'malformed') process.stdout.write('{broken')
else if (argv[0] === 'version') process.stdout.write(JSON.stringify(completed({ version: ${JSON.stringify(behavior)} === 'wrong-version' ? '3.2.9' : '3.3.0' })) + '\\n')
else if (argv[0] === 'capabilities') process.stdout.write(JSON.stringify(completed({ commands: ${JSON.stringify(behavior)} === 'missing-capability' ? commands.slice(0, -1) : commands })) + '\\n')
else { process.stderr.write('forbidden fake CLI command\\n'); process.exitCode = 64 }
`
}

async function installArchive(dshBin, archive) {
  const offline = await runAttemptLogged('plugin-add-offline', process.execPath, [
    dshBin, 'plugin', '--profile', 'web', 'add', archive, '--offline',
  ], { cwd: paths.workspace, env: controlledEnvironment() })
  if (offline.code === 0 && offline.signal === null) return { mode: 'offline', offlineFailure: null }
  if (!offline.stdout.includes('ERR_PNPM_NO_OFFLINE_META') && !offline.stderr.includes('ERR_PNPM_NO_OFFLINE_META')) {
    throw new Error(`offline plugin add failed for an unexpected reason\nstdout:\n${tail(offline.stdout)}\nstderr:\n${tail(offline.stderr)}`)
  }
  await runLogged('plugin-add-standard', process.execPath, [
    dshBin, 'plugin', '--profile', 'web', 'add', archive,
  ], { cwd: paths.workspace, env: controlledEnvironment() })
  return { mode: 'standard', offlineFailure: 'ERR_PNPM_NO_OFFLINE_META' }
}

async function verifyInstalled(dshBin, archive) {
  const profileDir = join(paths.dshHome, 'profiles', 'web')
  const why = await runLogged('plugin-why', process.execPath, [
    dshBin, 'plugin', '--profile', 'web', 'why', PACKAGE_NAME,
  ], { cwd: paths.workspace, env: controlledEnvironment() })
  if (!why.stdout.includes(PACKAGE_NAME)) throw new Error('plugin why did not identify the installed package')

  const dump = await runLogged('config-dump-installed', process.execPath, [
    dshBin, '--profile', 'web', '--dump-config',
  ], { cwd: paths.workspace, env: controlledEnvironment() })
  if ((dump.stdout.match(/id: dsh-md2wechat$/gmu) ?? []).length !== 1 || !dump.stdout.includes(`name: '${PACKAGE_NAME}'`)) {
    throw new Error('installed config dump does not contain exactly one plugin row')
  }

  const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  if (!manifest.dsh?.profile?.bundles?.includes(PACKAGE_NAME)) throw new Error('profile does not list the installed plugin bundle')
  const spec = manifest.dependencies?.[PACKAGE_NAME]
  if (spec !== `file:${archive}`) {
    throw new Error('profile dependency does not point at the packed archive')
  }
  const installedRoot = join(profileDir, 'node_modules', '@geekjourneyx', 'dsh-md2wechat')
  const installedManifest = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'))
  if (installedManifest.main !== 'lib/index.js') throw new Error('installed package main is not the built entry')
  await assertReadable(join(installedRoot, 'lib', 'index.js'))
  try {
    await access(join(installedRoot, 'src'))
    throw new Error('installed package contains source files')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return { profileDir, dependency: spec, why: why.stdout.trim() }
}

async function writeProbePlugin(fake) {
  const directory = join(inputs.taskRoot, 'probe')
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const module = join(directory, 'installed-probe.mjs')
  const result = join(paths.logs, 'assembled-probe.json')
  await writeFile(module, probePluginSource({ fake, result }), { mode: 0o600 })
  const patch = join(directory, 'probe.patch.yml')
  await writeFile(patch, [
    '- insert:',
    '    - id: dsh-md2wechat-installed-probe',
    `      name: ${pathToFileURL(module).href}`,
    '',
  ].join('\n'), { mode: 0o600 })
  return { module, patch, result }
}

function probePluginSource({ fake, result }) {
  const baseConfig = {
    binaryPath: fake.normal,
    stateDir: paths.stateDir,
    safeReadRetries: 0,
  }
  return `
import { existsSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

export const name = 'dsh-md2wechat-installed-probe'
export const inject = ['tools', 'systemPrompt', 'agents', 'agentPresets', 'loader']

const names = ${JSON.stringify(PLUGIN_TOOLS)}
const base = ${JSON.stringify(baseConfig)}
const expected = {
  base: names.slice(0, 6),
  write: names.slice(0, 7),
  all: names,
}

export function apply(ctx) {
  void ctx.loader.await().then(() => run(ctx)).catch(error => finish({ ok: false, error: safeError(error) }))
}

async function run(ctx) {
  const target = [...ctx.loader.entries()].find(entry => entry.options.id === 'dsh-md2wechat')
  if (target === undefined) throw new Error('installed plugin loader row is absent')
  if (target.options.name !== ${JSON.stringify(PACKAGE_NAME)}) throw new Error('installed row is not the package entry')
  const snapshots = []

  const snapshot = async (label, expectedTools, write, fallback) => {
    const tools = ctx.tools.schemas().map(tool => tool.name).filter(name => names.includes(name))
    if (JSON.stringify(tools) !== JSON.stringify(expectedTools)) throw new Error(label + ': unexpected tools ' + JSON.stringify(tools))
    const sections = (await ctx.systemPrompt.assemble()).sections.filter(section => section.name === 'tool:md2wechat')
    const text = sections.map(section => section.text).join('\\n')
    if ((sections.length === 1) !== (expectedTools.length > 0)) throw new Error(label + ': unexpected prompt section count')
    if (expectedTools.length > 0) {
      if (!text.includes('signed preview')) throw new Error(label + ': prompt omits signed preview')
      if (text.includes('md2wechat_create_draft') !== write) throw new Error(label + ': draft prompt gate mismatch')
      if (text.includes('md2wechat_generate_images') !== (write && fallback)) throw new Error(label + ': image prompt gate mismatch')
    }
    snapshots.push({ label, tools, text })
  }

  const configure = async (label, config, expectedTools, write, fallback) => {
    await target.update({ disabled: false, config })
    await ctx.loader.await()
    await snapshot(label, expectedTools, write, fallback)
  }

  await snapshot('installed-default', expected.all, true, true)
  await configure('base-only', { ...base, enableWechatWriteTools: false, enableFallbackImageTool: false }, expected.base, false, false)
  await configure('write-only', { ...base, enableWechatWriteTools: true, enableFallbackImageTool: false }, expected.write, true, false)
  await configure('fallback-without-write', { ...base, enableWechatWriteTools: false, enableFallbackImageTool: true }, expected.base, false, true)
  await configure('all-enabled', { ...base, enableWechatWriteTools: true, enableFallbackImageTool: true }, expected.all, true, true)

  await target.update({ disabled: true })
  await ctx.loader.await()
  await snapshot('disabled', [], false, false)
  await configure('re-enabled', { ...base, enableWechatWriteTools: true, enableFallbackImageTool: true }, expected.all, true, true)

  for (const [label, binaryPath] of [
    ['malformed', ${JSON.stringify(fake.malformed)}],
    ['wrong-version', ${JSON.stringify(fake['wrong-version'])}],
    ['missing-capability', ${JSON.stringify(fake['missing-capability'])}],
  ]) {
    await target.update({ disabled: true })
    await ctx.loader.await()
    let rejected = false
    try {
      await target.update({ disabled: false, config: { ...base, binaryPath } })
      await ctx.loader.await()
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error(label + ': invalid activation unexpectedly succeeded')
    await snapshot('failure-' + label, [], false, false)
  }

  await configure('real-cli', { ...base, binaryPath: ${JSON.stringify(inputs.cliPath)} }, expected.all, true, true)

  const handle = await ctx.agents.create({
    sessionId: '6e19cb47-3cb1-4b74-b697-63c2375adcf0',
    meta: { cwd: ${JSON.stringify(paths.workspace)} },
    setup: agentCtx => ctx.agentPresets.mount(agentCtx).then(() => undefined),
  })
  try {
    const execute = (callId, name, args) => ctx.tools.execute({
      callId,
      name,
      arguments: args,
      agent: handle.agent,
      signal: new AbortController().signal,
    })
    const fsPositive = await execute('task10-fs-positive', 'write', { file_path: 'agent-fs-positive', content: 'fs-ok' })
    const fsDenied = await execute('task10-fs-denied', 'write', { file_path: ${JSON.stringify(join(paths.stateDir, 'agent-fs-denied'))}, content: 'denied' })
    const shellName = process.platform === 'win32' ? 'pwsh' : 'bash'
    const shellPositiveCommand = process.platform === 'win32'
      ? ${JSON.stringify(`Set-Content -NoNewline -Path '${join(paths.workspace, 'agent-shell-positive')}' -Value 'shell-ok'`)}
      : ${JSON.stringify(`printf shell-ok > '${join(paths.workspace, 'agent-shell-positive')}'`)}
    const shellDeniedCommand = process.platform === 'win32'
      ? ${JSON.stringify(`Set-Content -NoNewline -Path '${join(paths.stateDir, 'agent-shell-denied')}' -Value 'denied'`)}
      : ${JSON.stringify(`printf denied > '${join(paths.stateDir, 'agent-shell-denied')}'`)}
    const shellPositive = await execute('task10-shell-positive', shellName, { command: shellPositiveCommand, description: 'Write workspace shell marker' })
    const shellDenied = await execute('task10-shell-denied', shellName, { command: shellDeniedCommand, description: 'Attempt external state write' })
    const text = outcome => outcome.content.filter(block => block.type === 'text').map(block => block.text).join('\\n')
    if (fsPositive.isError) throw new Error('assembled filesystem positive write failed: ' + text(fsPositive))
    if (!fsDenied.isError || !text(fsDenied).includes('[sandbox: file access denied under workspace-write mode]')) throw new Error('assembled filesystem external write was not denied')
    if (shellPositive.isError || text(shellPositive).includes('[sandbox:')) throw new Error('assembled shell positive write failed: ' + text(shellPositive))
    if (shellDenied.isError || !text(shellDenied).includes('[sandbox: file access denied under workspace-write mode]')) throw new Error('assembled shell external write was not denied')
    if ((await readFile(${JSON.stringify(join(paths.workspace, 'agent-fs-positive'))}, 'utf8')) !== 'fs-ok') throw new Error('filesystem positive bytes mismatch')
    if ((await readFile(${JSON.stringify(join(paths.workspace, 'agent-shell-positive'))}, 'utf8')) !== 'shell-ok') throw new Error('shell positive bytes mismatch')
    if (existsSync(${JSON.stringify(join(paths.stateDir, 'agent-fs-denied'))}) || existsSync(${JSON.stringify(join(paths.stateDir, 'agent-shell-denied'))})) throw new Error('external denied target exists')
  } finally {
    await handle.dispose()
  }

  const fakeCalls = (await readFile(${JSON.stringify(fake.log)}, 'utf8')).trim().split('\\n').filter(Boolean).map(line => JSON.parse(line))
  const expectedCalls = [
    ...Array.from({ length: 6 }, () => [['version', '--json'], ['capabilities', '--json']]).flat(),
    ['version', '--json'],
    ['version', '--json'],
    ['version', '--json'], ['capabilities', '--json'],
  ]
  if (JSON.stringify(fakeCalls.map(call => call.argv)) !== JSON.stringify(expectedCalls)) throw new Error('fake CLI call sequence mismatch: ' + JSON.stringify(fakeCalls))
  finish({
    ok: true,
    rowName: target.options.name,
    snapshots,
    fakeCalls,
    boundaries: { fsPositive: true, fsDenied: true, shellPositive: true, shellDenied: true },
  })
}

function safeError(error) {
  return error instanceof Error ? error.message : 'unknown installed probe failure'
}

function finish(value) {
  writeFileSync(${JSON.stringify(result)}, JSON.stringify(value, undefined, 2) + '\\n', { mode: 0o600 })
}
`
}

async function runWebAcceptance(dshBin, probe) {
  const child = spawn(process.execPath, [
    dshBin,
    '--profile', 'web',
    '--patch', probe.patch,
    '--host', '127.0.0.1',
    '--port', '0',
  ], {
    cwd: paths.workspace,
    env: controlledEnvironment({ MD2WECHAT_BINARY_PATH: fakePathFromProbe(probe) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })))
  try {
    const [url] = await Promise.all([
      waitFor(() => stdout.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/u)?.[1], 120_000, 'Web URL'),
      waitFor(async () => {
        try {
          const value = JSON.parse(await readFile(probe.result, 'utf8'))
          return value
        } catch (error) {
          if (error?.code === 'ENOENT') return undefined
          throw error
        }
      }, 120_000, 'assembled probe result'),
    ])
    const probeResult = JSON.parse(await readFile(probe.result, 'utf8'))
    if (probeResult.ok !== true) throw new Error(`assembled probe failed: ${probeResult.error ?? 'unknown failure'}`)
    const response = await fetch(url)
    const html = await response.text()
    if (response.status !== 200 || !html.includes('window.__DSH_BOOT__')) {
      throw new Error(`Web readiness response was ${response.status} without boot payload`)
    }
    child.kill('SIGTERM')
    const termination = await exited
    if (termination.code !== 0 || termination.signal !== null) {
      throw new Error(`Web SIGTERM did not exit cleanly: ${JSON.stringify(termination)}`)
    }
    await writeFile(join(paths.logs, 'web.stdout.log'), stdout, { mode: 0o600 })
    await writeFile(join(paths.logs, 'web.stderr.log'), stderr, { mode: 0o600 })
    return { url, httpStatus: response.status, bootPayload: true, exitCode: termination.code, probe: probeResult }
  } catch (error) {
    child.kill('SIGKILL')
    await exited
    await writeFile(join(paths.logs, 'web.stdout.log'), stdout, { mode: 0o600 })
    await writeFile(join(paths.logs, 'web.stderr.log'), stderr, { mode: 0o600 })
    throw new Error(`installed Web acceptance failed: ${error instanceof Error ? error.message : 'unknown'}\nstdout:\n${tail(stdout)}\nstderr:\n${tail(stderr)}`)
  }
}

function fakePathFromProbe(probe) {
  return join(dirname(dirname(probe.module)), 'fake-cli', 'md2wechat-normal')
}

async function uninstallArchive(dshBin) {
  await runLogged('plugin-remove', process.execPath, [
    dshBin, 'plugin', '--profile', 'web', 'remove', PACKAGE_NAME,
  ], { cwd: paths.workspace, env: controlledEnvironment() })
  const dump = await runLogged('config-dump-removed', process.execPath, [
    dshBin, '--profile', 'web', '--dump-config',
  ], { cwd: paths.workspace, env: controlledEnvironment() })
  if (dump.stdout.includes('dsh-md2wechat')) throw new Error('post-uninstall config dump still contains the plugin row')
  const manifest = JSON.parse(await readFile(join(paths.dshHome, 'profiles', 'web', 'package.json'), 'utf8'))
  if (manifest.dependencies?.[PACKAGE_NAME] !== undefined || manifest.dsh?.profile?.bundles?.includes(PACKAGE_NAME)) {
    throw new Error('post-uninstall profile still contains the plugin dependency or bundle')
  }
  return { dependencyRemoved: true, rowRemoved: true }
}

async function runLogged(label, command, args, options) {
  const result = await runAttemptLogged(label, command, args, options)
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`${label} failed (${String(result.code)}, ${String(result.signal)})\nstdout:\n${tail(result.stdout)}\nstderr:\n${tail(result.stderr)}`)
  }
  return result
}

async function runAttemptLogged(label, command, args, options) {
  const result = await run(command, args, options)
  await mkdir(paths.logs, { recursive: true, mode: 0o700 })
  await writeFile(join(paths.logs, `${label}.stdout.log`), result.stdout, { mode: 0o600 })
  await writeFile(join(paths.logs, `${label}.stderr.log`), result.stderr, { mode: 0o600 })
  return result
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveRun({ code, signal, stdout, stderr }))
  })
}

async function waitFor(read, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function tail(text) {
  return text.length <= 8_000 ? text : text.slice(-8_000)
}
