/** @jest-environment node */

import { readFileSync } from 'fs'
import { resolve } from 'path'

// App.vue cannot be mounted under Jest (it wires the whole relay/chat stack), so pin the one line
// that ties the launch of a returning user to the persistent-storage request (ticket #370). The
// behaviour behind it is covered by stores/persistent-storage.jest.test.ts.
describe('App launch requests persistent storage (ticket #370)', () => {
  it('asks once per launch, after mount, without awaiting or throwing', () => {
    const source = readFileSync(resolve(__dirname, 'App.vue'), 'utf8')
    const mounted = source.slice(source.indexOf('  mounted() {'))
    expect(mounted).toContain(
      'void usePersistentStorageStore().ensureForAccount()',
    )
  })
})
