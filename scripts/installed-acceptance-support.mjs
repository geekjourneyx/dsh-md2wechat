import { spawn } from 'node:child_process'
import { lstat, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const WORKFLOW_BASE = 'Use this order: md2wechat_start_article or md2wechat_improve_article -> md2wechat_plan_images -> md2wechat_preview -> md2wechat_export.'
const WORKFLOW_WRITE = 'Use this order: md2wechat_start_article or md2wechat_improve_article -> md2wechat_plan_images -> md2wechat_preview -> md2wechat_export or md2wechat_create_draft.'
const SIGNED_PREVIEW = 'Treat the signed preview as the source of truth for review and approval.'
const DRAFT_SAFETY = 'md2wechat_create_draft creates an unpublished WeChat draft and never publishes or mass-sends.'
const IMAGE_FALLBACK = 'Use md2wechat_generate_images only when image work is required and the current DSH agent has no other image-generation capability.'

export function createChildEnvironment({ ambient, taskRoot, dshHome, cliPath, extra = {} }) {
  const environment = {
    PATH: ambient.PATH ?? '',
    LANG: 'C',
    LC_ALL: 'C',
    HOME: resolve(taskRoot, 'home'),
    TMPDIR: resolve(taskRoot, 'tmp'),
    XDG_CONFIG_HOME: resolve(taskRoot, 'xdg', 'config'),
    XDG_CACHE_HOME: resolve(taskRoot, 'xdg', 'cache'),
    XDG_DATA_HOME: resolve(taskRoot, 'xdg', 'data'),
    PNPM_HOME: resolve(taskRoot, 'pnpm-home'),
    COREPACK_HOME: resolve(taskRoot, 'corepack-home'),
    npm_config_userconfig: resolve(taskRoot, 'npmrc'),
    NPM_CONFIG_USERCONFIG: resolve(taskRoot, 'npmrc'),
    npm_config_cache: resolve(taskRoot, 'npm-cache'),
    pnpm_config_store_dir: resolve(taskRoot, 'pnpm-store'),
    npm_config_update_notifier: 'false',
    NO_UPDATE_NOTIFIER: '1',
    CI: '1',
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_PERMISSION_MODE: 'workspace-write',
    MD2WECHAT_BINARY_PATH: cliPath,
  }
  for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) {
    if (process.platform === 'win32' && ambient[name] !== undefined) environment[name] = ambient[name]
  }
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined) delete environment[name]
    else environment[name] = value
  }
  return environment
}

export function expectedWorkflowPrompt(writeEnabled, fallbackEnabled) {
  const lines = [writeEnabled ? WORKFLOW_WRITE : WORKFLOW_BASE, SIGNED_PREVIEW]
  if (writeEnabled) {
    lines.push(DRAFT_SAFETY)
    if (fallbackEnabled) lines.push(IMAGE_FALLBACK)
  }
  return lines.join('\n')
}

export function assertWorkflowPrompt(sections, writeEnabled, fallbackEnabled) {
  const matches = sections.filter(section => section.name === 'tool:md2wechat')
  if (matches.length !== 1) throw new Error('expected exactly one md2wechat workflow prompt section')
  if (matches[0].text !== expectedWorkflowPrompt(writeEnabled, fallbackEnabled)) {
    throw new Error('md2wechat prompt does not contain the exact workflow text')
  }
}

export async function createTaskRootGuard(taskRoot, options) {
  if (!isAbsolute(taskRoot)) throw new Error('task root must be absolute')
  const resolvedRoot = resolve(taskRoot)
  const entry = await lstat(resolvedRoot)
  if (entry.isSymbolicLink()) throw new Error('task root must not be a symbolic link')
  if (!entry.isDirectory()) throw new Error('task root must be a directory')
  const canonicalRoot = await realpath(resolvedRoot)
  const native = await stat(canonicalRoot)
  const canonicalOptions = {
    ...options,
    userHome: options.userHome === undefined ? undefined : await canonicalOrResolved(options.userHome),
    forbiddenRoots: await Promise.all(options.forbiddenRoots.map(canonicalOrResolved)),
  }
  assertSafeCanonicalRoot(canonicalRoot, canonicalOptions)
  const identity = nativeIdentity(native)

  const assertCurrent = async () => {
    let currentEntry
    try {
      currentEntry = await lstat(resolvedRoot)
    } catch {
      throw new Error('task root identity changed')
    }
    if (currentEntry.isSymbolicLink() || !currentEntry.isDirectory()) throw new Error('task root identity changed')
    const currentCanonical = await realpath(resolvedRoot)
    const currentNative = await stat(currentCanonical)
    if (currentCanonical !== canonicalRoot || nativeIdentity(currentNative) !== identity) {
      throw new Error('task root identity changed')
    }
    assertSafeCanonicalRoot(currentCanonical, canonicalOptions)
  }

  const assertCleanupTarget = async (target) => {
    await assertCurrent()
    const resolvedTarget = resolve(target)
    if (!inside(resolvedTarget, canonicalRoot) || resolvedTarget === canonicalRoot) {
      throw new Error(`refusing to clean unsafe task path: ${resolvedTarget}`)
    }
    try {
      const targetEntry = await lstat(resolvedTarget)
      if (targetEntry.isSymbolicLink()) throw new Error(`refusing to clean symbolic-link task path: ${resolvedTarget}`)
      const canonicalTarget = await realpath(resolvedTarget)
      if (!inside(canonicalTarget, canonicalRoot) || canonicalTarget === canonicalRoot) {
        throw new Error(`refusing to clean escaped task path: ${resolvedTarget}`)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const canonicalParent = await realpath(dirname(resolvedTarget))
      if (!inside(canonicalParent, canonicalRoot)) throw new Error(`refusing to clean escaped task path: ${resolvedTarget}`)
    }
  }

  return { canonicalRoot, assertCurrent, assertCleanupTarget }
}

async function canonicalOrResolved(path) {
  try {
    return await realpath(resolve(path))
  } catch (error) {
    if (error?.code === 'ENOENT') return resolve(path)
    throw error
  }
}

function assertSafeCanonicalRoot(canonicalRoot, options) {
  const root = resolve(canonicalRoot)
  const parsedParts = root.split(sep).filter(Boolean)
  if (root === resolve(root, sep) || parsedParts.length < 3) throw new Error('task root is dangerously broad')
  const platformTempRoot = resolve(options.platformTempRoot)
  if (inside(root, platformTempRoot)) throw new Error('task root must stay outside the platform temporary directory')
  const userHome = options.userHome === undefined ? undefined : resolve(options.userHome)
  if (userHome !== undefined && (root === userHome || inside(userHome, root))) {
    throw new Error('task root must not be the user home or its ancestor')
  }
  for (const forbidden of options.forbiddenRoots) {
    const forbiddenRoot = resolve(forbidden)
    if (root === forbiddenRoot || inside(root, forbiddenRoot) || inside(forbiddenRoot, root)) {
      throw new Error(`task root overlaps protected source or state path: ${forbiddenRoot}`)
    }
  }
}

function nativeIdentity(value) {
  return `${String(value.dev)}:${String(value.ino)}`
}

function inside(candidate, parent) {
  const offset = relative(resolve(parent), resolve(candidate))
  return offset === '' || (!offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset))
}

export async function runBounded(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })

  const exit = new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  let timer
  const timeout = new Promise(resolveTimeout => {
    timer = setTimeout(() => resolveTimeout({ timedOut: true }), options.timeoutMs)
  })
  let first
  try {
    first = await Promise.race([exit, timeout])
  } finally {
    clearTimeout(timer)
  }
  if (first.timedOut !== true) return { ...first, stdout, stderr }

  await terminateProcessTree(child, exit, options.killGraceMs)
  const error = new Error(`${options.label} timed out after ${options.timeoutMs} ms`)
  error.stdout = stdout
  error.stderr = stderr
  throw error
}

export async function terminateProcessTree(child, exit, killGraceMs) {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    await taskkillProcessTree(child.pid, killGraceMs)
    await exit.catch(() => undefined)
    return
  }

  signalPosixGroup(child.pid, 'SIGTERM')
  if (await waitForGroupExit(child.pid, killGraceMs)) {
    await exit.catch(() => undefined)
    return
  }
  signalPosixGroup(child.pid, 'SIGKILL')
  const killed = await waitForGroupExit(child.pid, killGraceMs)
  await exit.catch(() => undefined)
  if (!killed) throw new Error(`process group ${child.pid} survived SIGKILL`)
}

function signalPosixGroup(pid, signal) {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

async function waitForGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(pid)) return true
    await delay(10)
  }
  return !isProcessGroupAlive(pid)
}

function isProcessGroupAlive(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

async function taskkillProcessTree(pid, timeoutMs) {
  const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  const exit = new Promise((resolveExit, rejectExit) => {
    killer.once('error', rejectExit)
    killer.once('exit', code => resolveExit(code))
  })
  let timer
  const timeout = new Promise(resolveTimeout => {
    timer = setTimeout(() => resolveTimeout('timeout'), timeoutMs)
  })
  let outcome
  try {
    outcome = await Promise.race([exit, timeout])
  } finally {
    clearTimeout(timer)
  }
  if (outcome === 'timeout') {
    killer.kill('SIGKILL')
    await exit.catch(() => undefined)
    throw new Error(`taskkill timed out after ${timeoutMs} ms`)
  }
  if (outcome !== 0 && isProcessAlive(pid)) throw new Error(`taskkill failed with exit code ${String(outcome)}`)
}

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}
