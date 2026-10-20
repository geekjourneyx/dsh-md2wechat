import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const root = resolve(import.meta.dirname, '../..')
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('generated baseline host contract', () => {
  it('loads both generated faces without a newer host runtime helper', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-typert-baseline-'))
    temporaryRoots.push(fixture)
    await mkdir(join(fixture, 'node_modules'))
    // The official baseline emitter needs only our own declared Zod dependency.
    // No fake host exports or patched host packages hide unavailable subpaths.
    await symlink(await realpath(join(root, 'node_modules/zod')), join(fixture, 'node_modules/zod'), 'dir')
    for (const face of ['typert.host.js', 'typert.remote-client.js']) {
      await cp(join(root, 'lib', face), join(fixture, face))
    }
    await writeFile(join(fixture, 'package.json'), '{"type":"module"}\n')
    await writeFile(join(fixture, 'check.mjs'), `
      import assert from 'node:assert/strict'
      import { TYPERT } from './typert.host.js'
      import { TYPERT_REMOTE } from './typert.remote-client.js'
      const ids = ['md2wechat/discoverRevisions', 'md2wechat/dispatch', 'md2wechat/get', 'md2wechat/list', 'md2wechat/open', 'md2wechat/recoverRevision', 'md2wechat/resume', 'md2wechat/session']
      for (const descriptors of [TYPERT.invocations, TYPERT_REMOTE.descriptors]) {
        assert.deepEqual(descriptors.map(value => value.namespace + '/' + value.method), ids)
        for (const descriptor of descriptors) {
          assert.deepEqual(descriptor.scope, { context: 'agent', wire: 'agentId' })
          assert.equal(descriptor.parameters[0].lookup, 'agent')
          assert.equal(descriptor.parameters[0].codec.create().parse('session-1'), 'session-1')
          assert.throws(() => descriptor.parameters[0].codec.create().parse({}))
          assert.deepEqual(descriptor.cancellation, { parameter: 'signal' })
          assert.equal(descriptor.parameters.some(value => value.name === 'owner' || value.name === 'ownerSessionId'), false)
        }
      }
      assert.equal(TYPERT.face, 'host')
      assert.equal(TYPERT.package, TYPERT_REMOTE.package)
      console.log('generated baseline contract loaded')
    `)
    const { stdout } = await exec(process.execPath, [join(fixture, 'check.mjs')], { cwd: fixture })
    expect(stdout).toContain('generated baseline contract loaded')
  })
})
