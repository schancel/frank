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
    const finishSource = readFileSync(
      resolve(__dirname, '../utils/setup-persistence.ts'),
      'utf8',
    )

    expect(source).toContain('initialize: () => initializeMonadIdentity()')
    // The completion push is wrapped in the authorized-navigation flag the route-leave guard
    // allows (#387), but it is still a direct router push on the production setup path.
    expect(source).toContain('this.completionNavigationAuthorized = true')
    expect(source).toContain(
      'return Promise.resolve(this.$router.push(path)).finally(() => {',
    )
    expect(source).toContain('const seed = commitValidatedSetupSeed(')
    expect(source).toContain('const name = commitValidatedSetupName(')
    expect(source).toContain('const submission = Object.freeze({')
    expect(source).toContain("this.completionPhase = 'wallet-persistence'")
    expect(source).toContain(
      'this.setSeedPhrase(submission.seed, submission.confirmedAt)',
    )
    expect(source).toContain('await useWalletStore().flushPersistence()')
    expect(source).toContain('name: submission.name,')
    expect(source).not.toContain("name: this.accountData.name || 'Frank User'")
    expect(source).toContain('await useProfileStore().flushPersistence()')
    expect(source).toContain('await this.finishSetup()')
    expect(source).toContain('finishReloads: setupFinishReloads()')
    expect(source).toContain('location: this.setupFinishLocation()')
    expect(source).toContain('return window.location')
    expect(source).not.toContain('reloadAfterPersistenceFailure')
    expect(finishSource).toContain('options.location.reload()')
    expect(
      source.indexOf('const seed = commitValidatedSetupSeed('),
    ).toBeLessThan(
      source.indexOf('this.avatar = await this.selectRandomAvatar()'),
    )
    expect(source.indexOf('this.setSeedPhrase(submission.seed')).toBeLessThan(
      source.indexOf('await useWalletStore().flushPersistence()'),
    )
    expect(
      source.indexOf('await useWalletStore().flushPersistence()'),
    ).toBeLessThan(source.indexOf('this.setRelayData({'))
    expect(source.lastIndexOf('this.setRelayData({')).toBeLessThan(
      source.indexOf('await useProfileStore().flushPersistence()'),
    )
    expect(
      source.indexOf('await useProfileStore().flushPersistence()'),
    ).toBeLessThan(source.lastIndexOf('await this.finishSetup()'))
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
