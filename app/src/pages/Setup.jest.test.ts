/** @jest-environment node */

import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('Setup persistence integration', () => {
  it('binds durable writes to in-place identity init on the production setup path', () => {
    // Setup.vue currently contains a Vite-owned `import.meta.url` asset lookup,
    // which Jest cannot execute in its CommonJS SFC transform. Pin this small
    // production binding directly so removing either the dependencies or the
    // awaited boundary still kills the regression while the helper's behavior
    // remains covered by setup-persistence.jest.test.ts.
    const source = readFileSync(resolve(__dirname, 'Setup.vue'), 'utf8')

    expect(source).toContain('initialize: () => initializeMonadIdentity()')
    expect(source).toContain('finishReloads: setupFinishReloads()')
    expect(source).toContain(
      'navigate: (path: string) => this.$router.push(path)',
    )
    expect(source).toContain(
      'this.accountData.seed = commitValidatedSetupSeed(',
    )
    expect(source).toContain('(seed, at) => this.setSeedPhrase(seed, at)')
    expect(source).toContain(
      'this.accountData.name = commitValidatedSetupName(',
    )
    expect(source).toContain('name =>\n          this.setRelayData({')
    expect(source).toContain('name,\n              bio:')
    expect(source).not.toContain("name: this.accountData.name || 'Frank User'")
    expect(source).toContain('await this.finishSetup()')
    expect(source).not.toContain('window.location.reload()')
    expect(source).not.toContain('location.reload()')
    expect(
      source.indexOf('this.accountData.seed = commitValidatedSetupSeed('),
    ).toBeLessThan(
      source.indexOf('this.accountData.name = commitValidatedSetupName('),
    )
    expect(
      source.indexOf('this.accountData.name = commitValidatedSetupName('),
    ).toBeLessThan(source.indexOf('this.setRelayData({'))
    expect(source.lastIndexOf('this.setRelayData({')).toBeLessThan(
      source.indexOf('await this.finishSetup()'),
    )
  })

  it('boots the same initializer and keeps reload behind the env flag', () => {
    const boot = readFileSync(
      resolve(__dirname, '../boot/monad-direct-messages.ts'),
      'utf8',
    )
    expect(boot).toContain('await initializeMonadIdentity()')
    expect(boot).toContain(
      "finishReloads: import.meta.env.QCLI_SETUP_FINISH_RELOAD === 'true'",
    )
    expect(boot).not.toContain('startDirectMessagePolling')
    expect(boot).not.toContain('location.reload')
  })
})
