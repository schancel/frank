import {
  toHex,
  verifyPreviewDirectoryEvidence,
} from '../../packages/frank-codec/src/index'
import { openBrowserDirectoryStore } from '../../packages/directory-admission/src/browser'
import {
  openDirectory,
  OpenDirectoryError,
} from '../../packages/cashweb/relay/open-directory'
import {
  createFakeRelay,
  testAccount,
} from '../../packages/cashweb/relay/open-directory-fake-relay.testutil'
import { browserDirectoryPersistence } from '../../app/src/utils/directory-persistence'

const NETWORK = 'monad-testnet'
const SECOND = 1_000_000_000n
const START = 1_800_000_000n * SECOND
const time = (ns: bigint) => ({
  seconds: ns / SECOND,
  nanoseconds: Number(ns % SECOND),
})
const assert = (value: unknown, description: string) => {
  if (!value) throw new Error(description)
}
const snapshot = () =>
  JSON.stringify(
    Object.keys(localStorage)
      .sort()
      .map(key => [key, localStorage.getItem(key)]),
  )

Object.assign(globalThis, {
  directoryTests: {
    async run({ action, seed = 100 }: { action: string; seed?: number }) {
      const alice = testAccount(seed)
      const relay = createFakeRelay()
      let predecessor: Uint8Array | null = null
      const chain = [0n, 1n, 2n].map(revision => {
        const bytes = alice.sign({
          network: NETWORK,
          revision,
          predecessor,
          issuedAt: time(START - (3600n - revision) * SECOND),
          expiresAt: time(START + 365n * 86400n * SECOND),
          relay: relay.binding,
        })
        predecessor = verifyPreviewDirectoryEvidence(
          bytes,
          NETWORK,
        ).statementHash
        return bytes
      })
      relay.replicate(chain)
      const storage = browserDirectoryPersistence()
      const pinKey = `${NETWORK}:${alice.address}`
      const pin = await storage.pins.load(pinKey)
      const name = `frank-directory:${NETWORK}:${alice.subject}:${pin}`
      if (action === 'missing-checkpoint')
        localStorage.removeItem(`frank-directory-checkpoint:${name}`)
      if (action === 'missing-db')
        await new Promise<void>((resolve, reject) => {
          const deletion = indexedDB.deleteDatabase(name)
          deletion.onsuccess = () => resolve()
          deletion.onerror = () => reject(deletion.error)
          deletion.onblocked = () =>
            reject(new Error('owned database deletion blocked'))
        })
      if (action === 'read-failure')
        storage.checkpoints.load = () => {
          throw new Error('owned read failure')
        }
      if (action === 'write-failure')
        storage.checkpoints.save = () => {
          throw new Error('owned write failure')
        }
      if (action === 'older')
        relay.tamper = path => (path.endsWith('/head') ? chain[0] : undefined)
      if (action === 'fork') {
        const other = alice.sign({
          network: NETWORK,
          revision: 2n,
          predecessor: verifyPreviewDirectoryEvidence(chain[1], NETWORK)
            .statementHash,
          issuedAt: time(START - 1800n * SECOND),
          expiresAt: time(START + 365n * 86400n * SECOND),
          relay: relay.binding,
        })
        relay.tamper = path => (path.endsWith('/head') ? other : undefined)
      }
      const before = snapshot()
      let deletions = 0
      const remove = indexedDB.deleteDatabase.bind(indexedDB)
      indexedDB.deleteDatabase = () => {
        deletions++
        throw new Error(
          'automatic delete forbidden, including blocked/error paths',
        )
      }
      let signed = 0
      const directory = openDirectory({
        network: NETWORK,
        relayBaseUrl: relay.endpoint,
        nowNs: () => START,
        fetch: relay.fetch,
        ...storage,
        openStore: options => openBrowserDirectoryStore(options),
        self: {
          subject: alice.subject,
          signRevisionZero: () => {
            signed++
            throw new Error('fixture must never sign')
          },
          signNextRevision: () => {
            signed++
            throw new Error('fixture must never sign')
          },
        },
      })
      let code = 'success'
      try {
        const entry = await directory.publish()
        assert(entry.current.revision === 2n, 'retained later revision')
      } catch (error) {
        if (!(error instanceof OpenDirectoryError)) throw error
        code = error.code
      } finally {
        await directory.close()
        indexedDB.deleteDatabase = remove
      }
      const expected =
        action === 'init'
          ? 'success'
          : ['fork', 'quarantine'].includes(action)
          ? 'fork'
          : action === 'older'
          ? 'rollback'
          : 'storage'
      assert(code === expected, `${action}: expected ${expected}, got ${code}`)
      assert(
        deletions === 0 && signed === 0,
        'no deletion or reenrollment signing',
      )
      if (action !== 'init' && action !== 'fork')
        assert(snapshot() === before, 'all retained continuity bytes unchanged')
      if (action === 'fork' || action === 'quarantine') {
        const checkpoint = await browserDirectoryPersistence().checkpoints.load(
          name,
        )
        assert(checkpoint?.forked, 'fork checkpoint retained')
      }
      return {
        ok: true,
        action,
        code,
        seed,
        deletions,
        signed,
        pin: toHex(
          verifyPreviewDirectoryEvidence(chain[0], NETWORK).statementHash,
        ),
      }
    },
  },
})
