/** @jest-environment node */

import { readFileSync } from 'fs'
import { resolve } from 'path'

// Pin the healthy runtime's persistence and provenance ordering after its move from App.vue.
// App.startup.jest.test.ts mounts the real root/runtime; the storage owner's behavior is covered
// separately by stores/persistent-storage.jest.test.ts.
describe('App launch requests persistent storage (ticket #370)', () => {
  it('asks once per launch, after mount, without awaiting or throwing', () => {
    const source = readFileSync(resolve(__dirname, 'AppRuntime.vue'), 'utf8')
    const mounted = source.slice(source.indexOf('  mounted() {'))
    expect(mounted).toContain(
      'void usePersistentStorageStore().ensureForAccount()',
    )
  })

  it('installs curated provenance before adding fallback labels and refreshing signed profiles (#422)', () => {
    const source = readFileSync(resolve(__dirname, 'AppRuntime.vue'), 'utf8')
    const loader = source.slice(
      source.indexOf('    loadCuratedDefaults() {'),
      source.indexOf('    setupConnections() {'),
    )
    const replace = loader.indexOf('this.replaceCuratedDefaults(contacts)')
    const add = loader.indexOf('await this.addDefaultContact(contact)')
    const refresh = loader.indexOf('await this.refreshContacts()')

    expect(replace).toBeGreaterThan(-1)
    expect(add).toBeGreaterThan(replace)
    expect(refresh).toBeGreaterThan(add)
    expect(loader).toContain('this.clearCuratedDefaults()')
  })
})
