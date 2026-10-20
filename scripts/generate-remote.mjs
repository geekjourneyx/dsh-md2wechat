import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { WorkspaceAnalyzer, FaceModelEmitter } from '@deepseek-ai/dsh-typert-generator'

// Use the official 0.2.0-rc.2 emitter as the baseline contract: its generated
// descriptors also load on 0.2.1-rc.2 without the newer /remote-info helper.
// The public analyzer recognizes protocol types by workspace identity. Stage
// authentic published declarations for analysis only; no runtime shim ships.
const root = resolve(import.meta.dirname, '..')
const name = '@geekjourneyx/dsh-md2wechat'
const stage = await mkdtemp(join(tmpdir(), 'md2wechat-typert-'))
try {
  const pkgRoot = join(stage, 'packages', 'md2wechat')
  await mkdir(pkgRoot, { recursive: true })
  await cp(join(root, 'src'), join(pkgRoot, 'src'), { recursive: true })
  await cp(join(root, 'package.json'), join(pkgRoot, 'package.json'))
  // Analyze only the controller's public surface, not unrelated tool services.
  await writeFile(join(pkgRoot, 'src/index.ts'), "export { CreatorRemote } from './creator/remote.ts'\n")
  await symlink(join(root, 'node_modules'), join(stage, 'node_modules'), 'dir')
  const config = JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8'))
  config.compilerOptions.paths = {}
  config.include = ['src/index.ts']; config.exclude = ['src/client']
  const references = [{ path: './packages/md2wechat/tsconfig.host.json' }]
  const require = createRequire(await realpath(join(root, 'node_modules/@deepseek-ai/dsh-agent/package.json')))
  for (const dependency of ['dsh-typert-protocol', 'dsh-agent', 'dsh-session']) {
    const installed = dirname(require.resolve(`@deepseek-ai/${dependency}/package.json`))
    const destination = join(stage, 'packages', dependency)
    await mkdir(destination, { recursive: true })
    await symlink(join(installed, '../..'), join(destination, 'node_modules'), 'dir')
    await cp(join(installed, 'lib/types'), join(destination, 'declarations'), { recursive: true })
    const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
    for (const [key, value] of Object.entries(manifest.exports)) {
      if (typeof value === 'object' && value.types) {
        const declaration = value.types.replace('./lib/types/', './declarations/')
        manifest.exports[key] = { types: declaration, default: declaration }
      }
    }
    await writeFile(join(destination, 'package.json'), JSON.stringify(manifest))
    config.compilerOptions.paths[`@deepseek-ai/${dependency}`] = [join(destination, 'declarations/index.d.ts')]
    config.compilerOptions.paths[`@deepseek-ai/${dependency}/*`] = [join(destination, 'declarations/*.d.ts')]
    references.push({ path: `./packages/${dependency}/tsconfig.host.json` })
    await writeFile(join(destination, 'tsconfig.host.json'), JSON.stringify({
      compilerOptions: { ...config.compilerOptions, rootDir: '.' }, include: ['declarations/**/*.d.ts'],
    }))
  }
  await writeFile(join(pkgRoot, 'tsconfig.host.json'), JSON.stringify(config))
  await writeFile(join(stage, 'tsconfig.host.json'), JSON.stringify({ compilerOptions: config.compilerOptions, files: [], references }))
  const model = new WorkspaceAnalyzer({ root: stage, packages: [name], faces: ['host'] }).analyze()
  const artifacts = model.faces.map(face => ({ ...new FaceModelEmitter(face).emit(name), packageRoot: pkgRoot }))
  if (!artifacts.some(artifact => artifact.remote)) throw new Error('Creator Remote methods were not generated')
  // 0.2.0 exposes the emitter, but not 0.2.1's writePackageArtifacts helper.
  // Persist the official emitter's bytes unchanged, including declaration maps.
  const output = join(root, 'lib')
  await mkdir(output, { recursive: true })
  for (const artifact of artifacts) {
    await writeFile(join(output, `typert.${artifact.face}.js`), artifact.js)
    await writeFile(join(output, `typert.${artifact.face}.d.ts`), artifact.dts)
    if (artifact.remote) {
      await writeFile(join(output, 'typert.remote-client.js'), artifact.remote.js)
      await writeFile(join(output, 'typert.remote-client.d.ts'), artifact.remote.dts)
      await writeFile(join(output, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
    }
  }
} finally { await rm(stage, { recursive: true, force: true }) }
