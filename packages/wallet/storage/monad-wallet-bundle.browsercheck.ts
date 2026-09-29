/** Real-browser IndexedDB/Web-Locks check. Run through Vite in Chrome; it deliberately uses the
 * package's browser-resolved `level` backend rather than a memory fake. */
import { join } from 'path'

import { MonadHdKeyring } from '../monad-hd-keyring'
import { LevelChangePoolStore } from './level-change-pool-store'
import { LevelSubAccountPoolStore } from './level-sub-account-pool-store'
import { openMonadWalletBundle } from './monad-wallet-bundle'
import { LevelStampAttemptJournal } from './stamp-attempt-journal'
import { LevelStampPaymentJournal } from './stamp-payment-journal'
import {
  WALLET_COMPONENT_NAMES,
  canonicalWalletStorageLocation,
} from './wallet-root-guard'

const MNEMONIC = 'test test test test test test test test test test test junk'
const WRONG_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function deleteRoot(location: string): Promise<void> {
  const idb = (globalThis as any).indexedDB
  const canonical = canonicalWalletStorageLocation(location)
  for (const component of WALLET_COMPONENT_NAMES) {
    await new Promise<void>((resolve, reject) => {
      const request = idb.deleteDatabase(
        `level-js-${join(canonical, component)}`
      )
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('IndexedDB cleanup blocked'))
    })
  }
}

async function createLegacyRoot(location: string): Promise<void> {
  const keyring = MonadHdKeyring.fromMnemonic(MNEMONIC)
  const stores = [
    new LevelSubAccountPoolStore(location),
    new LevelChangePoolStore(location),
    new LevelStampAttemptJournal(location),
    new LevelStampPaymentJournal(location),
  ]
  for (const [index, store] of stores.entries()) {
    await store.Open()
    ;(
      globalThis as any
    ).document.body.textContent = `MONAD_WALLET_BROWSERCHECK_LEGACY_OPEN_${index}`
  }
  ;(stores[0] as LevelSubAccountPoolStore).put({
    index: 7,
    address: keyring.deriveSubAccount(7).address,
    status: 'unfunded',
  })
  for (const store of stores.slice().reverse()) await store.Close()
}

export async function runMonadWalletBundleBrowserCheck(): Promise<void> {
  const prefix = `wallet-browsercheck-${Date.now()}`
  const report = (stage: string): void => {
    const document = (globalThis as any).document
    if (document !== undefined) document.body.textContent = stage
  }
  report('MONAD_WALLET_BROWSERCHECK_STARTED')
  await new Promise<void>((resolve, reject) => {
    const request = (globalThis as any).indexedDB.open(`${prefix}-probe`, 1)
    request.onsuccess = () => {
      request.result.close()
      const deletion = (globalThis as any).indexedDB.deleteDatabase(
        `${prefix}-probe`
      )
      deletion.onsuccess = () => resolve()
      deletion.onerror = () => reject(deletion.error)
    }
    request.onerror = () => reject(request.error)
  })
  report('MONAD_WALLET_BROWSERCHECK_IDB_READY')
  const migratedRoot = `${prefix}-migrate`
  const concurrentRoot = `${prefix}-concurrent`
  const aliasRoot = `${prefix}-alias`
  const wrongRoot = `${prefix}-wrong`
  const crashRoots: string[] = []
  try {
    await createLegacyRoot(migratedRoot)
    report('MONAD_WALLET_BROWSERCHECK_LEGACY_CREATED')
    const migrated = await openMonadWalletBundle({
      location: migratedRoot,
      seed: { mnemonic: MNEMONIC },
    })
    assert(migrated.pool.nextUnusedIndex() === 8, 'legacy high-water lost')
    report('MONAD_WALLET_BROWSERCHECK_MIGRATED')
    await migrated.close()
    const reopened = await openMonadWalletBundle({
      location: migratedRoot,
      seed: { mnemonic: MNEMONIC },
    })
    assert(reopened.pool.deriveNextUnfunded().index === 8, 'index was reused')
    report('MONAD_WALLET_BROWSERCHECK_REOPENED')
    await reopened.close()

    const existingContenders = await Promise.allSettled([
      openMonadWalletBundle({
        location: migratedRoot,
        seed: { mnemonic: MNEMONIC },
      }),
      openMonadWalletBundle({
        location: migratedRoot,
        seed: { mnemonic: MNEMONIC },
      }),
    ])
    const existingWinners = existingContenders.filter(
      (result) => result.status === 'fulfilled'
    )
    assert(existingWinners.length === 1, 'existing root had multiple owners')
    const existingWinner = existingWinners[0]
    assert(existingWinner.status === 'fulfilled', 'existing root had no owner')
    await existingWinner.value.close()

    await createLegacyRoot(wrongRoot)
    let wrongSeedRejected = false
    try {
      await openMonadWalletBundle({
        location: wrongRoot,
        seed: { mnemonic: WRONG_MNEMONIC },
      })
    } catch {
      wrongSeedRejected = true
    }
    assert(wrongSeedRejected, 'wrong browser seed was accepted')
    const databases = await (globalThis as any).indexedDB.databases()
    assert(
      !databases.some(
        (database: { name?: string }) =>
          database.name === `level-js-${join(wrongRoot, 'wallet-manifest')}`
      ),
      'wrong seed wrote a browser manifest'
    )

    for (const phase of [
      'validated',
      'marker',
      'sub-account-pool',
      'change-pool',
      'outgoing-stamp-attempts',
      'stamp-payment-journal',
      'manifest',
    ] as const) {
      const crashRoot = `${prefix}-crash-${phase}`
      crashRoots.push(crashRoot)
      await createLegacyRoot(crashRoot)
      try {
        await openMonadWalletBundle({
          location: crashRoot,
          seed: { mnemonic: MNEMONIC },
          onMigrationPhase: (reached) => {
            if (reached === phase) throw new Error(`crash:${phase}`)
          },
        })
      } catch {
        // Expected injected crash; the next open must finish the same migration.
      }
      const resumed = await openMonadWalletBundle({
        location: crashRoot,
        seed: { mnemonic: MNEMONIC },
      })
      assert(resumed.pool.nextUnusedIndex() === 8, `failed resume:${phase}`)
      await resumed.close()
    }

    const contenders = await Promise.allSettled([
      openMonadWalletBundle({
        location: concurrentRoot,
        createSeedIfEmpty: true,
      }),
      openMonadWalletBundle({
        location: concurrentRoot,
        createSeedIfEmpty: true,
      }),
    ])
    const winners = contenders.filter((result) => result.status === 'fulfilled')
    assert(winners.length === 1, 'browser root had multiple owners')
    report('MONAD_WALLET_BROWSERCHECK_CONCURRENT')
    const winner = winners[0]
    assert(winner.status === 'fulfilled', 'browser root had no owner')
    winner.value.pool.deriveNextUnfunded()
    await winner.value.pool.flush()
    await winner.value.close()
    const successor = await openMonadWalletBundle({
      location: concurrentRoot,
      createSeedIfEmpty: true,
    })
    assert(successor.pool.nextUnusedIndex() === 1, 'successor lost high-water')
    await successor.close()

    const aliasContenders = await Promise.allSettled([
      openMonadWalletBundle({
        location: aliasRoot,
        createSeedIfEmpty: true,
      }),
      openMonadWalletBundle({
        location: `./${aliasRoot}`,
        createSeedIfEmpty: true,
      }),
    ])
    const aliasWinners = aliasContenders.filter(
      (result) => result.status === 'fulfilled'
    )
    assert(aliasWinners.length === 1, 'browser alias had multiple owners')
    const aliasWinner = aliasWinners[0]
    assert(aliasWinner.status === 'fulfilled', 'browser alias had no owner')
    aliasWinner.value.pool.deriveNextUnfunded()
    await aliasWinner.value.pool.flush()
    await aliasWinner.value.close()
    const aliasSuccessor = await openMonadWalletBundle({
      location: `./${aliasRoot}`,
      createSeedIfEmpty: true,
    })
    assert(aliasSuccessor.pool.nextUnusedIndex() === 1, 'alias split storage')
    await aliasSuccessor.close()
  } finally {
    await deleteRoot(migratedRoot)
    await deleteRoot(concurrentRoot)
    await deleteRoot(aliasRoot)
    await deleteRoot(wrongRoot)
    for (const root of crashRoots) await deleteRoot(root)
  }
}

const browserDocument = (globalThis as any).document
if (browserDocument !== undefined) {
  void runMonadWalletBundleBrowserCheck().then(
    () => {
      browserDocument.body.textContent = 'MONAD_WALLET_BROWSERCHECK_PASS'
    },
    (error: unknown) => {
      browserDocument.body.textContent = `MONAD_WALLET_BROWSERCHECK_FAIL:${String(
        error
      )}`
    }
  )
}
