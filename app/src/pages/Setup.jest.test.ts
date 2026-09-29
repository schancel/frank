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
    expect(source).toContain('await this.persistSetupAndReload()')
  })
})
