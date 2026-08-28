import { describe, expect, it } from 'vitest'
import { createChildEnvironment } from '../../scripts/installed-acceptance-support.mjs'

describe('installed acceptance child environment', () => {
  it('uses only task-private package-manager state and drops ambient credentials', () => {
    const taskRoot = '/private/task-10'
    const environment = createChildEnvironment({
      ambient: {
        PATH: '/usr/bin:/bin',
        HOME: '/Users/real-user',
        NPM_TOKEN: 'npm-secret',
        NODE_AUTH_TOKEN: 'node-secret',
        DEEPSEEK_API_KEY: 'provider-secret',
        HTTPS_PROXY: 'http://credential@example.test',
      },
      taskRoot,
      dshHome: `${taskRoot}/dsh-home`,
      cliPath: `${taskRoot}/md2wechat`,
    })

    expect(environment).toMatchObject({
      PATH: '/usr/bin:/bin',
      HOME: `${taskRoot}/home`,
      DSH_HOME: `${taskRoot}/dsh-home`,
      XDG_CONFIG_HOME: `${taskRoot}/xdg/config`,
      XDG_CACHE_HOME: `${taskRoot}/xdg/cache`,
      PNPM_HOME: `${taskRoot}/pnpm-home`,
      npm_config_userconfig: `${taskRoot}/npmrc`,
      npm_config_cache: `${taskRoot}/npm-cache`,
      pnpm_config_store_dir: `${taskRoot}/pnpm-store`,
      MD2WECHAT_BINARY_PATH: `${taskRoot}/md2wechat`,
    })
    expect(Object.keys(environment)).not.toEqual(expect.arrayContaining([
      'NPM_TOKEN',
      'NODE_AUTH_TOKEN',
      'DEEPSEEK_API_KEY',
      'HTTPS_PROXY',
    ]))
    expect(Object.values(environment)).not.toContain('provider-secret')
  })
})
