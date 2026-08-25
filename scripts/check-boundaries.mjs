import { execFileSync } from 'node:child_process'
import { lstat, readdir } from 'node:fs/promises'
import { basename, relative, resolve, sep } from 'node:path'

const FORBIDDEN_BASENAMES = new Set(['go.mod', 'go.sum'])
const FORBIDDEN_SUFFIXES = ['.go']
const FORBIDDEN_EXECUTABLES = [/^md2wechat(?:-|$)/u]
const ALLOWED_ROOTS = new Set([
  '.gitignore', 'CHANGELOG.md', 'LICENSE', 'README.md', 'cordis.patch.yml',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'scripts', 'src',
  'tests', 'tsconfig.json', 'tsconfig.prepare.json', 'tsdown.config.ts',
  'tsdown.prepare.config.ts', 'vitest.config.ts',
])
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'lib', 'coverage'])

/** Run Git and return whether it completed successfully. */
function gitSucceeds(root, args) {
  try {
    execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Return whether an untracked .superpowers directory is ignored by Git. */
function ignoredOrchestrationWorkspace(root) {
  return !gitSucceeds(root, ['ls-files', '--error-unmatch', '--', '.superpowers'])
    && gitSucceeds(root, ['check-ignore', '--quiet', '--', '.superpowers'])
}

/** Return a violation reason for a forbidden file name, if any. */
function forbiddenReason(path) {
  const name = basename(path)
  if (FORBIDDEN_BASENAMES.has(name)) return 'forbidden Go module file'
  if (FORBIDDEN_SUFFIXES.some(suffix => name.endsWith(suffix))) return 'forbidden Go source file'
  if (FORBIDDEN_EXECUTABLES.some(pattern => pattern.test(name))) return 'forbidden md2wechat executable'
  return undefined
}

/** Record a violation using the path presented to a package consumer. */
function record(violations, path, reason) {
  violations.push(`${path}: ${reason}`)
}

/** Inspect a directory tree without traversing symbolic links. */
async function inspectRepository(root, violations) {
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name)
      const path = relative(root, absolute)
      const rootEntry = path.split(sep, 1)[0]

      if (rootEntry === '.superpowers') {
        if (!ignoredOrchestrationWorkspace(root)) {
          record(violations, path, 'orchestration workspace must be untracked and ignored')
        }
        continue
      }
      if (rootEntry !== undefined && IGNORED_DIRECTORIES.has(rootEntry)) continue

      const reason = forbiddenReason(path)
      if (reason !== undefined) record(violations, path, reason)
      if (directory === root && !ALLOWED_ROOTS.has(entry.name)) {
        record(violations, path, 'unexpected repository root entry')
      }
      if (entry.isDirectory()) await walk(absolute)
      if (entry.isSymbolicLink()) await lstat(absolute)
    }
  }

  await walk(root)
}

/** Inspect a gzip-compressed package archive without extracting it. */
function inspectArchive(archive, violations) {
  let listing
  try {
    listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
  } catch {
    record(violations, archive, 'cannot inspect package archive')
    return
  }

  for (const entry of listing.split('\n')) {
    const path = entry.replace(/^\.\//u, '')
    if (path === '') continue
    const packagedPath = path.startsWith('package/') ? path.slice('package/'.length) : path
    const reason = forbiddenReason(packagedPath)
    if (reason !== undefined) record(violations, path, reason)
    if (packagedPath === '.superpowers' || packagedPath.startsWith('.superpowers/')) {
      record(violations, path, 'orchestration workspace must not be packed')
    }
    if (path.endsWith('/')) continue
  }
}

const target = process.argv[2]
if (target === undefined) {
  console.error('usage: node scripts/check-boundaries.mjs <repository-or-package-archive>')
  process.exitCode = 1
} else {
  const absoluteTarget = resolve(target)
  const targetStats = await lstat(absoluteTarget).catch(() => undefined)
  const violations = []

  if (targetStats === undefined) {
    record(violations, target, 'path does not exist')
  } else if (targetStats.isDirectory()) {
    await inspectRepository(absoluteTarget, violations)
  } else {
    inspectArchive(absoluteTarget, violations)
  }

  if (violations.length === 0) {
    console.log('plugin boundary: clean')
  } else {
    for (const violation of violations) console.error(violation)
    process.exitCode = 1
  }
}
