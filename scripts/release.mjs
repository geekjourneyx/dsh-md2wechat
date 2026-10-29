import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const packageName = '@geekjourneyx/dsh-md2wechat'
// Release versions deliberately exclude build metadata to keep asset/tag identity unique.
const numeric = '(?:0|[1-9][0-9]*)'
const identifier = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`
const releaseVersion = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?$`, 'u')

function validate(tag, manifest) {
  const version = manifest.version
  if (manifest.name !== packageName || typeof version !== 'string'
    || !releaseVersion.test(version) || /\s/u.test(version) || tag !== `v${version}`) {
    throw new Error('Release tag must exactly match the package name and SemVer version (vX.Y.Z[-prerelease], no build metadata).')
  }
  if (version === '1.0.0') throw new Error('The existing v1.0.0 release must never be replaced.')
  return { version, tag, prerelease: version.includes('-') }
}

function artifact(metadata, archive, output) {
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n')
  const required = ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'lib/typert.host.js', 'lib/typert.remote-client.js']
  for (const path of required) {
    if (entries.filter(entry => entry === `package/${path}`).length !== 1) throw new Error(`Missing or duplicate runtime entry: ${path}`)
  }
  for (const entry of entries) {
    if (!/^package\/(?:$|lib\/$|lib\/types\/(?:[A-Za-z0-9_./-]*\/|[A-Za-z0-9_./-]+\.d\.ts)?|lib\/(?:index|client|typert\.host|typert\.remote-client)\.(?:js|d\.ts)|package\.json|cordis\.patch\.yml|README\.md|CHANGELOG\.md|LICENSE|assets\/(?:$|feature-wall-0[123]\.png|readme\/(?:$|readme-hero\.webp)))$/u.test(entry)
      || entry.split('/').includes('..')) throw new Error(`Unexpected packaged file: ${entry}`)
  }
  const packed = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }))
  validate(metadata.tag, packed)
  if (['preinstall', 'install', 'postinstall', 'prepare'].some(hook => packed.scripts?.[hook])) throw new Error('Published package must not require source lifecycle scripts.')
  const name = `geekjourneyx-dsh-md2wechat-${metadata.version}.tgz`
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex')
  mkdirSync(output, { recursive: false })
  copyFileSync(archive, join(output, name), constants.COPYFILE_EXCL)
  writeFileSync(join(output, 'SHA256SUMS'), `${digest}  ${name}\n`, { flag: 'wx' })
}

try {
  const [mode, tag, archive, output] = process.argv.slice(2)
  const metadata = validate(tag, JSON.parse(readFileSync('package.json', 'utf8')))
  if (mode === 'artifact' && archive && output) artifact(metadata, archive, output)
  else if (mode !== 'validate' || archive || output) throw new Error('Usage: release.mjs validate TAG | artifact TAG ARCHIVE NEW_OUTPUT_DIRECTORY')
  console.log(JSON.stringify(metadata))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
