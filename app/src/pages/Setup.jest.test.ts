/** @jest-environment node */

import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('Setup persistence integration', () => {
  it('binds and crosses the durable boundary on the production setup path', () => {
    // Setup.vue currently contains a Vite-owned `import.meta.url` asset lookup,
    // which Jest cannot execute in its CommonJS SFC transform. Pin this small
    // production binding directly so removing either the dependencies or the
    // awaited boundary still kills the regression while the helper's behavior
    // remains covered by setup-persistence.jest.test.ts.
    const source = readFileSync(resolve(__dirname, 'Setup.vue'), 'utf8')

    expect(source).toContain(
      'persistSetupAndReload(wallet, myProfile, window.location, errorNotify)',
    )
    expect(source).toContain(
      'this.accountData.seed = commitValidatedSetupSeed(',
    )
    expect(source).toContain('seed => this.setSeedPhrase(seed)')
    expect(source).toContain(
      'this.accountData.name = commitValidatedSetupName(',
    )
    expect(source).toContain('name =>\n              this.setRelayData({')
    expect(source).toContain('name,\n                  bio:')
    expect(source).not.toContain("name: this.accountData.name || 'Frank User'")
    expect(source).toContain('await this.persistSetupAndReload()')
    expect(
      source.indexOf('this.accountData.seed = commitValidatedSetupSeed('),
    ).toBeLessThan(
      source.indexOf('this.accountData.name = commitValidatedSetupName('),
    )
    expect(
      source.indexOf('this.accountData.name = commitValidatedSetupName('),
    ).toBeLessThan(source.indexOf('this.setRelayData({'))
    expect(source.lastIndexOf('this.setRelayData({')).toBeLessThan(
      source.indexOf('await this.persistSetupAndReload()'),
    )
  })
})
