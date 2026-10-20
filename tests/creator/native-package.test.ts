import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('native creator package contract', () => {
  it('exports native client and generated authenticated Remote faces', async () => {
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
    expect(pkg.exports['./client']).toBeDefined()
    expect(pkg.exports['./typert']).toBeDefined()
    expect(pkg.exports['./remote']).toBeDefined()
    expect(pkg.dsh.client.platform).toBe('web')
  })
})
