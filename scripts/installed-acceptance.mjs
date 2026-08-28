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
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  createChildEnvironment,
  createTaskRootGuard,
  expectedWorkflowPrompt,
  runBounded,
  stopProcessTreeBounded,
} from './installed-acceptance-support.mjs'

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
const timeouts = validateTimeouts(process.env)
const paths = {
  dshHome: join(inputs.taskRoot, 'dsh-home'),
  workspace: join(inputs.taskRoot, 'workspace'),
  tarballs: join(inputs.taskRoot, 'tarballs'),
  logs: join(inputs.taskRoot, 'logs'),
  home: join(inputs.taskRoot, 'home'),
  temp: join(inputs.taskRoot, 'tmp'),
  xdg: join(inputs.taskRoot, 'xdg'),
  pnpmHome: join(inputs.taskRoot, 'pnpm-home'),
  corepackHome: join(inputs.taskRoot, 'corepack-home'),
  npmCache: join(inputs.taskRoot, 'npm-cache'),
  pnpmStore: join(inputs.taskRoot, 'pnpm-store'),
  stateDir: join(inputs.taskRoot, 'dsh-home', 'plugins', 'dsh-md2wechat'),
}
let taskRootGuard

await main()

function validateInputs(environment) {
  const dshCheckout = absoluteInput(environment.DSH_CHECKOUT, 'DSH_CHECKOUT')
  const cliPath = absoluteInput(environment.MD2WECHAT_CLI, 'MD2WECHAT_CLI')
  const taskRoot = absoluteInput(environment.DSH_MD2WECHAT_TASK_ROOT, 'DSH_MD2WECHAT_TASK_ROOT')
  const sourceRoot = optionalAbsoluteInput(environment.MD2WECHAT_SOURCE_ROOT, 'MD2WECHAT_SOURCE_ROOT')
  return { dshCheckout, cliPath, taskRoot, sourceRoot }
}

function absoluteInput(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`)
  }
  return resolve(value)
}

function optionalAbsoluteInput(value, name) {
  return value === undefined ? undefined : absoluteInput(value, name)
}

function validateTimeouts(environment) {
  return {
    command: durationInput(environment.DSH_MD2WECHAT_COMMAND_TIMEOUT_MS, 'DSH_MD2WECHAT_COMMAND_TIMEOUT_MS', 180_000),
    webStartup: durationInput(environment.DSH_MD2WECHAT_WEB_STARTUP_TIMEOUT_MS, 'DSH_MD2WECHAT_WEB_STARTUP_TIMEOUT_MS', 120_000),
    http: durationInput(environment.DSH_MD2WECHAT_HTTP_TIMEOUT_MS, 'DSH_MD2WECHAT_HTTP_TIMEOUT_MS', 10_000),
    webShutdown: durationInput(environment.DSH_MD2WECHAT_WEB_SHUTDOWN_TIMEOUT_MS, 'DSH_MD2WECHAT_WEB_SHUTDOWN_TIMEOUT_MS', 10_000),
    killGrace: durationInput(environment.DSH_MD2WECHAT_KILL_GRACE_MS, 'DSH_MD2WECHAT_KILL_GRACE_MS', 2_000),
  }
}

function durationInput(value, name, fallback) {
  if (value === undefined) return fallback
  if (!/^[1-9]\d*$/u.test(value)) throw new Error(`${name} must be a positive integer`)
  const milliseconds = Number(value)
  if (!Number.isSafeInteger(milliseconds) || milliseconds > 900_000) throw new Error(`${name} exceeds the supported limit`)
  return milliseconds
}

function inside(candidate, parent) {
  const offset = relative(resolve(parent), resolve(candidate))
  return offset === '' || (!offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset))
}

async function main() {
  await assertReadable(join(inputs.dshCheckout, 'apps', 'cli', 'package.json'))
  await assertExecutable(inputs.cliPath)
  taskRootGuard = await createTaskRootGuard(inputs.taskRoot, {
    platformTempRoot: tmpdir(),
    userHome: homedir(),
    forbiddenRoots: [repositoryRoot, inputs.dshCheckout, process.env.DSH_HOME, inputs.sourceRoot].filter(Boolean),
  })
  await assertPrivateTaskRoot()
  await resetRunDirectories()

  const cli = await probeRealCli()
  await buildPlugin()
  const archive = await packPlugin()
  await assertArchive(archive)

  await buildDsh()
  const dshBin = join(inputs.dshCheckout, 'apps', 'cli', 'lib', 'bin.js')
  await assertReadable(dshBin)

  let installAttempted = false
  let installation
  let install
  let web
  let removal
  try {
    const fake = await writeFakeExecutables()
    installAttempted = true
    installation = await installArchive(dshBin, archive)
    install = await verifyInstalled(dshBin, archive)
    const probe = await writeProbePlugin(fake)
    web = await runWebAcceptance(dshBin, probe)
    removal = await uninstallArchive(dshBin)
    installAttempted = false
  } finally {
    if (installAttempted) await bestEffortUninstall(dshBin)
  }

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
  await taskRootGuard.assertCurrent()
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
  for (const path of [
    paths.dshHome,
    paths.workspace,
    paths.tarballs,
    paths.logs,
    paths.home,
    paths.temp,
    paths.xdg,
    paths.pnpmHome,
    paths.corepackHome,
    paths.npmCache,
    paths.pnpmStore,
    join(inputs.taskRoot, 'fake-cli'),
    join(inputs.taskRoot, 'probe'),
  ]) {
    await resetTaskDirectory(path)
  }
  await mkdir(join(paths.xdg, 'config'), { recursive: true, mode: 0o700 })
  await mkdir(join(paths.xdg, 'cache'), { recursive: true, mode: 0o700 })
  await mkdir(join(paths.xdg, 'data'), { recursive: true, mode: 0o700 })
  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 })
  await writeFile(join(inputs.taskRoot, 'npmrc'), `store-dir=${paths.pnpmStore}\n`, { mode: 0o600 })
  await chmod(paths.stateDir, 0o700)
}

async function resetTaskDirectory(path) {
  await taskRootGuard.assertCleanupTarget(path)
  await rm(path, { recursive: true, force: true })
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

function controlledEnvironment(extra = {}) {
  return createChildEnvironment({
    ambient: process.env,
    taskRoot: inputs.taskRoot,
    dshHome: paths.dshHome,
    cliPath: inputs.cliPath,
    extra,
  })
}

async function probeRealCli() {
  const versionRun = await runLogged('cli-version', inputs.cliPath, ['version', '--json'], {
    cwd: paths.home,
    env: controlledEnvironment({ DSH_HOME: undefined, DSH_PERMISSION_MODE: undefined, MD2WECHAT_BINARY_PATH: undefined }),
  })
  const version = parseCompletedEnvelope(versionRun.stdout, 'version')
  if (version.data?.version !== '3.3.0') throw new Error(`real CLI version is not 3.3.0: ${JSON.stringify(version.data)}`)

  const capabilitiesRun = await runLogged('cli-capabilities', inputs.cliPath, ['capabilities', '--json'], {
    cwd: paths.home,
    env: controlledEnvironment({ DSH_HOME: undefined, DSH_PERMISSION_MODE: undefined, MD2WECHAT_BINARY_PATH: undefined }),
  })
  const capabilities = parseCompletedEnvelope(capabilitiesRun.stdout, 'capabilities')
  const commands = capabilities.data?.commands
  if (!Array.isArray(commands) || REQUIRED_COMMANDS.some(command => !commands.includes(command))) {
    throw new Error('real CLI capabilities omit a command required by the plugin')
  }
  return { version: version.data.version, commands }
}

async function buildPlugin() {
  const environment = controlledEnvironment({
    DSH_HOME: undefined,
    DSH_PERMISSION_MODE: undefined,
    MD2WECHAT_BINARY_PATH: undefined,
  })
  await runLogged('plugin-build-types', process.execPath, [
    join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-b',
  ], { cwd: repositoryRoot, env: environment })
  await runLogged('plugin-build-runtime', process.execPath, [
    join(repositoryRoot, 'node_modules', 'tsdown', 'dist', 'run.mjs'),
  ], { cwd: repositoryRoot, env: environment })
}

async function buildDsh() {
  const tsc = join(inputs.dshCheckout, 'node_modules', 'typescript', 'bin', 'tsc')
  const tsdown = join(inputs.dshCheckout, 'node_modules', 'tsdown', 'dist', 'run.mjs')
  const environment = controlledEnvironment({
    DSH_HOME: undefined,
    DSH_PERMISSION_MODE: undefined,
    MD2WECHAT_BINARY_PATH: undefined,
  })
  await runLogged('dsh-build-host-types', process.execPath, [tsc, '-b', 'tsconfig.host.json'], {
    cwd: inputs.dshCheckout,
    env: environment,
  })
  await runLogged('dsh-build-host-runtime', process.execPath, [tsdown, '--env.DSH_BUILD_FACE', 'host'], {
    cwd: inputs.dshCheckout,
    env: environment,
  })
  await runLogged('dsh-build-client-types', process.execPath, [tsc, '-b', 'tsconfig.client.json'], {
    cwd: inputs.dshCheckout,
    env: environment,
  })
  await runLogged('dsh-build-client-runtime', process.execPath, [tsdown, '--env.DSH_BUILD_FACE', 'client'], {
    cwd: inputs.dshCheckout,
    env: environment,
  })
  await runLogged('dsh-build-web', process.execPath, [
    join(inputs.dshCheckout, 'apps', 'web', 'node_modules', 'vite', 'bin', 'vite.js'), 'build',
  ], {
    cwd: join(inputs.dshCheckout, 'apps', 'web'),
    env: environment,
  })
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
  await runLogged('plugin-pack', 'npm', ['pack', '--ignore-scripts', '--pack-destination', paths.tarballs], { cwd: repositoryRoot })
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
  await resetTaskDirectory(directory)
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
  await resetTaskDirectory(directory)
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
  const prompts = {
    base: expectedWorkflowPrompt(false, false),
    write: expectedWorkflowPrompt(true, false),
    all: expectedWorkflowPrompt(true, true),
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
const prompts = ${JSON.stringify(prompts)}

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
    const text = sections[0]?.text ?? ''
    if (expectedTools.length === 0 && sections.length !== 0) throw new Error(label + ': disabled prompt section remained')
    if (expectedTools.length > 0 && sections.length !== 1) throw new Error(label + ': expected exactly one prompt section')
    const expectedPrompt = write ? (fallback ? prompts.all : prompts.write) : prompts.base
    if (expectedTools.length > 0 && text !== expectedPrompt) throw new Error(label + ': prompt does not match the exact gated workflow')
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

function failureMessage(error) {
  if (error instanceof AggregateError) {
    return `${error.message}: ${error.errors.map(failureMessage).join('; ')}`
  }
  return error instanceof Error ? error.message : 'unknown failure'
}

async function runWebAcceptance(dshBin, probe) {
  const webEnvironment = controlledEnvironment({ MD2WECHAT_BINARY_PATH: fakePathFromProbe(probe) })
  const child = spawn(process.execPath, [
    dshBin,
    '--profile', 'web',
    '--patch', probe.patch,
    '--host', '127.0.0.1',
    '--port', '0',
  ], {
    cwd: paths.workspace,
    env: webEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  let stopped = false
  try {
    const readiness = Promise.all([
      waitFor(() => stdout.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/u)?.[1], timeouts.webStartup, 'Web URL'),
      waitFor(async () => {
        try {
          const value = JSON.parse(await readFile(probe.result, 'utf8'))
          return value
        } catch (error) {
          if (error?.code === 'ENOENT') return undefined
          throw error
        }
      }, timeouts.webStartup, 'assembled probe result'),
    ])
    const [url] = await Promise.race([
      readiness,
      exited.then(outcome => { throw new Error(`Web exited before readiness: ${JSON.stringify(outcome)}`) }),
    ])
    const probeResult = JSON.parse(await readFile(probe.result, 'utf8'))
    if (probeResult.ok !== true) throw new Error(`assembled probe failed: ${probeResult.error ?? 'unknown failure'}`)
    const response = await fetch(url, { signal: AbortSignal.timeout(timeouts.http) })
    const html = await response.text()
    if (response.status !== 200 || !html.includes('window.__DSH_BOOT__')) {
      throw new Error(`Web readiness response was ${response.status} without boot payload`)
    }
    const termination = await stopProcessTreeBounded(child, exited, {
      environment: webEnvironment,
      killGraceMs: timeouts.killGrace,
      exitTimeoutMs: timeouts.webShutdown,
      label: 'installed Web',
    })
    stopped = true
    if (termination.code !== 0 || termination.signal !== null) {
      throw new Error(`Web SIGTERM did not exit cleanly: ${JSON.stringify(termination)}`)
    }
    return { url, httpStatus: response.status, bootPayload: true, exitCode: termination.code, probe: probeResult }
  } catch (error) {
    const acceptanceError = new Error(`installed Web acceptance failed: ${failureMessage(error)}\nstdout:\n${tail(stdout)}\nstderr:\n${tail(stderr)}`, { cause: error })
    let cleanupError
    if (!stopped) {
      try {
        await stopProcessTreeBounded(child, exited, {
          environment: webEnvironment,
          killGraceMs: timeouts.killGrace,
          exitTimeoutMs: timeouts.webShutdown,
          label: 'failed installed Web',
        })
      } catch (error) {
        cleanupError = error
      }
    }
    stopped = true
    if (cleanupError !== undefined) {
      throw new AggregateError([acceptanceError, cleanupError], 'installed Web acceptance and cleanup failed')
    }
    throw acceptanceError
  } finally {
    await writeFile(join(paths.logs, 'web.stdout.log'), stdout, { mode: 0o600 })
    await writeFile(join(paths.logs, 'web.stderr.log'), stderr, { mode: 0o600 })
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

async function bestEffortUninstall(dshBin) {
  try {
    await runAttemptLogged('plugin-remove-cleanup', process.execPath, [
      dshBin, 'plugin', '--profile', 'web', 'remove', PACKAGE_NAME,
    ], { cwd: paths.workspace, env: controlledEnvironment() })
  } catch {
    // The primary acceptance failure remains authoritative after bounded cleanup.
  }
}

async function runLogged(label, command, args, options) {
  const result = await runAttemptLogged(label, command, args, options)
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`${label} failed (${String(result.code)}, ${String(result.signal)})\nstdout:\n${tail(result.stdout)}\nstderr:\n${tail(result.stderr)}`)
  }
  return result
}

async function runAttemptLogged(label, command, args, options) {
  await mkdir(paths.logs, { recursive: true, mode: 0o700 })
  try {
    const result = await runBounded(command, args, {
      cwd: options.cwd,
      env: options.env ?? controlledEnvironment(),
      timeoutMs: options.timeoutMs ?? timeouts.command,
      killGraceMs: timeouts.killGrace,
      label,
    })
    await writeFile(join(paths.logs, `${label}.stdout.log`), result.stdout, { mode: 0o600 })
    await writeFile(join(paths.logs, `${label}.stderr.log`), result.stderr, { mode: 0o600 })
    return result
  } catch (error) {
    await writeFile(join(paths.logs, `${label}.stdout.log`), error?.stdout ?? '', { mode: 0o600 })
    await writeFile(join(paths.logs, `${label}.stderr.log`), error?.stderr ?? '', { mode: 0o600 })
    throw error
  }
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
