/** Real-browser IndexedDB/Web-Locks check. Run through Vite in Chrome; it deliberately uses the
 * package's browser-resolved `level` backend rather than a memory fake. */
import { join } from 'path'
import level from 'level'
import { Transaction, Wallet, computeAddress, getBytes, hexlify } from 'ethers'

import { MonadChangeKeyring } from '../monad-change-keyring'
import { MonadHdKeyring } from '../monad-hd-keyring'
import {
  buildMonadStampCalldata,
  computeMonadStampCommitment,
  computeMonadStampPaymentCommitment,
} from '../monad-stamp-client'
import { deriveMonadStampChildPublic } from '../monad-stamp-stealth'
import { LevelChangePoolStore } from './level-change-pool-store'
import { LevelSubAccountPoolStore } from './level-sub-account-pool-store'
import { openMonadWalletBundle } from './monad-wallet-bundle'
import { LevelStampAttemptJournal } from './stamp-attempt-journal'
import { LevelStampPaymentJournal } from './stamp-payment-journal'
import {
  WALLET_COMPONENT_NAMES,
  acquireBrowserWalletRootLease,
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
  await new Promise<void>((resolve, reject) => {
    const request = idb.deleteDatabase(
      `frank-monad-wallet-creation:${canonical}`
    )
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('IndexedDB cleanup blocked'))
  })
}

async function readBrowserCreationIntent(location: string): Promise<{
  persistedSeed?: { mnemonic: string; passphrase: string }
}> {
  const idb = (globalThis as any).indexedDB
  const databaseName = `frank-monad-wallet-creation:${canonicalWalletStorageLocation(
    location
  )}`
  const database = await new Promise<any>((resolve, reject) => {
    const request = idb.open(databaseName)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    const encoded = await new Promise<string>((resolve, reject) => {
      const transaction = database.transaction('creation-intent', 'readonly')
      const request = transaction.objectStore('creation-intent').get('intent')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    return JSON.parse(encoded) as {
      persistedSeed?: { mnemonic: string; passphrase: string }
    }
  } finally {
    database.close()
  }
}

async function writeRawBrowserCreationIntent(
  location: string,
  encoded: string
): Promise<void> {
  const idb = (globalThis as any).indexedDB
  const databaseName = `frank-monad-wallet-creation:${canonicalWalletStorageLocation(
    location
  )}`
  const database = await new Promise<any>((resolve, reject) => {
    const request = idb.open(databaseName, 1)
    request.onupgradeneeded = () =>
      request.result.createObjectStore('creation-intent')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('creation-intent', 'readwrite', {
        durability: 'strict',
      })
      transaction.objectStore('creation-intent').put(encoded, 'intent')
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}

async function createEmptyBrowserCreationIntentDatabase(
  location: string
): Promise<void> {
  const idb = (globalThis as any).indexedDB
  const databaseName = `frank-monad-wallet-creation:${canonicalWalletStorageLocation(
    location
  )}`
  const database = await new Promise<any>((resolve, reject) => {
    const request = idb.open(databaseName, 1)
    request.onupgradeneeded = () =>
      request.result.createObjectStore('creation-intent')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  database.close()
}

async function createLegacyRoot(
  location: string,
  withRecord = true
): Promise<void> {
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
  if (withRecord) {
    for (let index = 0; index <= 7; index++) {
      ;(stores[0] as LevelSubAccountPoolStore).put({
        index,
        address: keyring.deriveSubAccount(index).address,
        status: 'unfunded',
      })
    }
  }
  for (const store of stores.slice().reverse()) await store.Close()
}

async function createLegacyFinalizedRoot(location: string) {
  const subKeyring = MonadHdKeyring.fromMnemonic(MNEMONIC)
  const changeKeyring = MonadChangeKeyring.fromMnemonic(MNEMONIC)
  const sender = subKeyring.deriveSubAccount(0)
  const change = changeKeyring.deriveChangeAccount(0)
  const funder = new Wallet(`0x${'11'.repeat(32)}`)
  const fundingRaw = await funder.signTransaction({
    to: sender.address,
    value: 100n,
    nonce: 0,
    gasLimit: 21_000n,
    gasPrice: 1n,
    chainId: 1,
  })
  const spendRaw = await new Wallet(sender.privateKey).signTransaction({
    to: funder.address,
    value: 5n,
    nonce: 0,
    gasLimit: 50_000n,
    gasPrice: 1n,
    chainId: 1,
  })
  const changeRaw = await new Wallet(sender.privateKey).signTransaction({
    to: change.address,
    value: 80n,
    nonce: 1,
    gasLimit: 21_000n,
    gasPrice: 1n,
    chainId: 1,
  })
  const changeTxHash = Transaction.from(changeRaw).hash as string
  const sub = new LevelSubAccountPoolStore(location)
  await sub.Open()
  sub.put({
    index: 0,
    address: sender.address,
    status: 'spent',
    lifecycle: {
      funding: {
        rawTx: fundingRaw,
        txHash: Transaction.from(fundingRaw).hash as string,
        valueWei: '100',
      },
      spend: {
        rawTx: spendRaw,
        txHash: Transaction.from(spendRaw).hash as string,
        valueWei: '5',
      },
      recovery: {
        kind: 'change',
        valueWei: '80',
        changeIndex: 0,
        address: change.address,
        txHash: changeTxHash,
      },
    },
  })
  await sub.Close()
  const changeRecord = {
    index: 0,
    address: change.address,
    sourceBurnIndex: 0,
    sourceBurnAddress: sender.address,
    sweptValueWei: '80',
    txHash: changeTxHash,
    rawTx: changeRaw,
    createdAt: 1,
  }
  const changeStore = new LevelChangePoolStore(location)
  await changeStore.Open()
  changeStore.putRecord(changeRecord)
  changeStore.setNextIndex(1)
  await changeStore.Close()
  const rawChange = level(join(location, 'change-pool'))
  const { rawTx: _changeRaw, ...legacyChange } = changeRecord
  await rawChange.put('0', JSON.stringify(legacyChange))
  await rawChange.close()

  const recipientPublicKeyHex = new Wallet(`0x${'22'.repeat(32)}`).signingKey
    .compressedPublicKey
  const envelopeRecipientAddress = computeAddress(recipientPublicKeyHex)
  const payloadHash = computeMonadStampCommitment(
    new TextEncoder().encode('browser legacy payment')
  )
  const destination = deriveMonadStampChildPublic({
    payloadHash,
    recipientPublicKey: getBytes(recipientPublicKeyHex),
    paymentIndex: 0,
  }).address
  const paymentRaw = await funder.signTransaction({
    to: destination,
    value: 7n,
    data: buildMonadStampCalldata(
      computeMonadStampPaymentCommitment(payloadHash, 0)
    ),
    nonce: 1,
    gasLimit: 50_000n,
    gasPrice: 1n,
    chainId: 1,
  })
  const payloadHashHex = hexlify(payloadHash).slice(2)
  const paymentRecord = {
    payloadHashHex,
    childIndex: 0,
    txHash: Transaction.from(paymentRaw).hash as string,
    rawTx: paymentRaw,
    recipientPublicKeyHex,
    envelopeRecipientAddress,
    address: destination,
    valueWei: '7',
    status: 'discovered' as const,
  }
  const payments = new LevelStampPaymentJournal(location)
  await payments.Open()
  await payments.put(paymentRecord)
  await payments.Close()
  const rawPayments = level(join(location, 'stamp-payment-journal'))
  const {
    rawTx: _paymentRaw,
    recipientPublicKeyHex: _recipient,
    envelopeRecipientAddress: _envelope,
    ...legacyPayment
  } = paymentRecord
  await rawPayments.put(`${payloadHashHex}:0`, JSON.stringify(legacyPayment))
  await rawPayments.close()
  const attempts = new LevelStampAttemptJournal(location)
  await attempts.Open()
  await attempts.Close()
  return {
    changeRaw,
    paymentRaw,
    recipientPublicKeyHex,
    envelopeRecipientAddress,
    payloadHashHex,
  }
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
  const finalizedRoot = `${prefix}-finalized`
  const emptyLegacyRoot = `${prefix}-empty-legacy`
  const callerSeedRoot = `${prefix}-caller-seed`
  const invalidModeRoot = `${prefix}-invalid-mode`
  const malformedIntentRoots = [
    `${prefix}-malformed-json-intent`,
    `${prefix}-malformed-shape-intent`,
  ]
  const callerCreationCrashRoots: string[] = []
  const generatedCreationCrashRoots: string[] = []
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

    await createLegacyRoot(emptyLegacyRoot, false)
    let emptyLegacyRejected = false
    try {
      await openMonadWalletBundle({
        location: emptyLegacyRoot,
        seed: { mnemonic: MNEMONIC },
        mode: 'create',
      })
    } catch {
      emptyLegacyRejected = true
    }
    assert(
      emptyLegacyRejected,
      'semantically empty browser legacy root accepted a supplied seed'
    )
    assert(
      !(await (globalThis as any).indexedDB.databases()).some(
        (database: { name?: string }) =>
          database.name ===
          `level-js-${join(emptyLegacyRoot, 'wallet-manifest')}`
      ),
      'empty browser legacy root wrote a manifest'
    )

    let invalidModeRejected = false
    try {
      await openMonadWalletBundle({
        location: invalidModeRoot,
        seed: { mnemonic: MNEMONIC },
        mode: 'create',
        createSeedIfEmpty: true,
      } as never)
    } catch {
      invalidModeRejected = true
    }
    assert(invalidModeRejected, 'invalid browser creation mode was accepted')
    assert(
      !(await (globalThis as any).indexedDB.databases()).some(
        (database: { name?: string }) =>
          database.name?.includes(invalidModeRoot)
      ),
      'invalid browser creation mode wrote IndexedDB state'
    )

    for (const [index, encoded] of [
      '{',
      JSON.stringify({ version: 1 }),
    ].entries()) {
      const malformedRoot = malformedIntentRoots[index]
      await writeRawBrowserCreationIntent(malformedRoot, encoded)
      let pageError: unknown
      const onError = (event: any) => {
        pageError = event.error ?? event.message
      }
      ;(globalThis as any).addEventListener('error', onError)
      try {
        const outcome = await Promise.race([
          openMonadWalletBundle({
            location: malformedRoot,
            seed: { mnemonic: MNEMONIC },
            mode: 'create',
          }).then(
            () => 'resolved',
            () => 'rejected'
          ),
          new Promise<string>((resolve) =>
            setTimeout(() => resolve('hung'), 1_000)
          ),
        ])
        assert(
          outcome === 'rejected',
          'malformed browser intent did not reject promptly'
        )
        assert(
          pageError === undefined,
          'malformed browser intent escaped as a page error'
        )
        const lease = await acquireBrowserWalletRootLease(malformedRoot)
        assert(
          lease !== undefined,
          'malformed browser intent stranded its Web Lock'
        )
        await lease.release()
      } finally {
        ;(globalThis as any).removeEventListener('error', onError)
      }
    }

    for (const phase of [
      'creation-intent',
      'validated',
      'marker',
      'sub-account-pool',
      'change-pool',
      'outgoing-stamp-attempts',
      'stamp-payment-journal',
      'manifest',
    ] as const) {
      const creationCrashRoot = `${prefix}-caller-crash-${phase}`
      callerCreationCrashRoots.push(creationCrashRoot)
      let crashed = false
      try {
        await openMonadWalletBundle({
          location: creationCrashRoot,
          seed: { mnemonic: MNEMONIC },
          mode: 'create',
          onMigrationPhase: async (current) => {
            if (current === phase) throw new Error(`browser crash ${phase}`)
          },
        })
      } catch {
        crashed = true
      }
      assert(crashed, `browser creation did not crash at ${phase}`)
      let wrongSeedRejected = false
      try {
        await openMonadWalletBundle({
          location: creationCrashRoot,
          seed: { mnemonic: WRONG_MNEMONIC },
          mode: 'create',
        })
      } catch {
        wrongSeedRejected = true
      }
      assert(
        wrongSeedRejected,
        `browser creation intent accepted wrong seed after ${phase}`
      )
      const resumed = await openMonadWalletBundle({
        location: creationCrashRoot,
        seed: { mnemonic: MNEMONIC },
        mode: 'create',
      })
      await resumed.close()
      assert(
        !(await (globalThis as any).indexedDB.databases()).some(
          (database: { name?: string }) =>
            database.name === `frank-monad-wallet-creation:${creationCrashRoot}`
        ),
        `browser creation intent survived successful resume after ${phase}`
      )
    }

    for (const phase of [
      'creation-intent',
      'validated',
      'marker',
      'sub-account-pool',
      'change-pool',
      'outgoing-stamp-attempts',
      'stamp-payment-journal',
      'manifest',
    ] as const) {
      const creationCrashRoot = `${prefix}-generated-crash-${phase}`
      generatedCreationCrashRoots.push(creationCrashRoot)
      let crashed = false
      try {
        await openMonadWalletBundle({
          location: creationCrashRoot,
          createSeedIfEmpty: true,
          onMigrationPhase: async (current) => {
            if (current === phase) throw new Error(`generated crash ${phase}`)
          },
        })
      } catch {
        crashed = true
      }
      assert(crashed, `generated browser creation did not crash at ${phase}`)
      const retained = await readBrowserCreationIntent(creationCrashRoot)
      assert(
        retained.persistedSeed !== undefined,
        `generated browser seed was not retained after ${phase}`
      )
      const expectedAddress = MonadHdKeyring.fromMnemonic(
        retained.persistedSeed.mnemonic,
        retained.persistedSeed.passphrase
      ).deriveSubAccount(0).address
      const resumed = await openMonadWalletBundle({
        location: creationCrashRoot,
        createSeedIfEmpty: true,
      })
      assert(
        resumed.pool.deriveNextUnfunded().address === expectedAddress,
        `generated browser seed changed after ${phase}`
      )
      await resumed.pool.flush()
      await resumed.close()
    }

    const callerSeedContenders = await Promise.allSettled([
      openMonadWalletBundle({
        location: callerSeedRoot,
        seed: { mnemonic: MNEMONIC },
        mode: 'create',
      }),
      openMonadWalletBundle({
        location: callerSeedRoot,
        seed: { mnemonic: MNEMONIC },
        mode: 'create',
      }),
    ])
    const callerSeedWinners = callerSeedContenders.filter(
      (result) => result.status === 'fulfilled'
    )
    assert(
      callerSeedWinners.length === 1,
      'browser caller-seed root had multiple creators'
    )
    const callerCreatedResult = callerSeedWinners[0]
    assert(
      callerCreatedResult.status === 'fulfilled',
      'browser caller-seed root had no creator'
    )
    const callerCreated = callerCreatedResult.value
    assert(
      callerCreated.pool.deriveNextUnfunded().address ===
        MonadHdKeyring.fromMnemonic(MNEMONIC).deriveSubAccount(0).address,
      'browser caller-seed creation substituted a different seed'
    )
    await callerCreated.pool.flush()
    await callerCreated.close()
    const callerReopened = await openMonadWalletBundle({
      location: callerSeedRoot,
      seed: { mnemonic: MNEMONIC },
      mode: 'create',
    })
    assert(
      callerReopened.pool.nextUnusedIndex() === 1,
      'browser caller-seed root did not reopen'
    )
    await callerReopened.close()
    await createEmptyBrowserCreationIntentDatabase(callerSeedRoot)
    const callerAfterIntentCleanupCrash = await openMonadWalletBundle({
      location: callerSeedRoot,
      seed: { mnemonic: MNEMONIC },
      mode: 'create',
    })
    assert(
      callerAfterIntentCleanupCrash.pool.nextUnusedIndex() === 1,
      'empty browser creation-intent residue blocked reopen'
    )
    await callerAfterIntentCleanupCrash.close()

    const legacyFinalized = await createLegacyFinalizedRoot(finalizedRoot)
    let finalizedOutageRejected = false
    try {
      await openMonadWalletBundle({
        location: finalizedRoot,
        seed: { mnemonic: MNEMONIC },
        resolveLegacyChangeRawTransaction: async () => {
          throw new Error('browser RPC outage')
        },
        resolveLegacyPaymentAuthority: async () => ({
          rawTx: legacyFinalized.paymentRaw,
          recipientPublicKeyHex: legacyFinalized.recipientPublicKeyHex,
          envelopeRecipientAddress: legacyFinalized.envelopeRecipientAddress,
        }),
      })
    } catch {
      finalizedOutageRejected = true
    }
    assert(
      finalizedOutageRejected,
      'browser legacy authority outage was accepted'
    )
    assert(
      !(await (globalThis as any).indexedDB.databases()).some(
        (database: { name?: string }) =>
          database.name === `level-js-${join(finalizedRoot, 'wallet-manifest')}`
      ),
      'browser authority outage wrote a manifest'
    )
    const finalized = await openMonadWalletBundle({
      location: finalizedRoot,
      seed: { mnemonic: MNEMONIC },
      resolveLegacyChangeRawTransaction: async () => legacyFinalized.changeRaw,
      resolveLegacyPaymentAuthority: async () => ({
        rawTx: legacyFinalized.paymentRaw,
        recipientPublicKeyHex: legacyFinalized.recipientPublicKeyHex,
        envelopeRecipientAddress: legacyFinalized.envelopeRecipientAddress,
      }),
    })
    assert(
      finalized.changePool.records()[0].rawTx === legacyFinalized.changeRaw,
      'browser legacy change authority was not persisted'
    )
    assert(
      finalized.stampPaymentJournal.get(legacyFinalized.payloadHashHex, 0)
        ?.envelopeRecipientAddress === legacyFinalized.envelopeRecipientAddress,
      'browser legacy payment authority was not persisted'
    )
    await finalized.close()
    const finalizedReopened = await openMonadWalletBundle({
      location: finalizedRoot,
      seed: { mnemonic: MNEMONIC },
    })
    assert(
      finalizedReopened.stampPaymentJournal.get(
        legacyFinalized.payloadHashHex,
        0
      )?.rawTx === legacyFinalized.paymentRaw,
      'browser legacy payment authority was lost on reopen'
    )
    await finalizedReopened.close()

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
        location: `${aliasRoot}/`,
        createSeedIfEmpty: true,
      }),
      openMonadWalletBundle({
        location: `${aliasRoot}\\`,
        createSeedIfEmpty: true,
      }),
      openMonadWalletBundle({
        location: `${prefix}-alias-parent\\..\\${aliasRoot}`,
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

    const browserNavigator = (globalThis as any).navigator
    const realLocks = browserNavigator.locks
    Object.defineProperty(browserNavigator, 'locks', {
      configurable: true,
      value: {
        request: () => Promise.reject(new Error('injected Web Lock failure')),
      },
    })
    try {
      const outcome = await Promise.race([
        acquireBrowserWalletRootLease(`${prefix}-rejected-lock`).then(
          () => 'resolved',
          () => 'rejected'
        ),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve('hung'), 1_000)
        ),
      ])
      assert(outcome === 'rejected', 'Web Lock rejection hung readiness')
    } finally {
      Object.defineProperty(browserNavigator, 'locks', {
        configurable: true,
        value: realLocks,
      })
    }
  } finally {
    await deleteRoot(migratedRoot)
    await deleteRoot(concurrentRoot)
    await deleteRoot(aliasRoot)
    await deleteRoot(wrongRoot)
    await deleteRoot(finalizedRoot)
    await deleteRoot(emptyLegacyRoot)
    await deleteRoot(callerSeedRoot)
    await deleteRoot(invalidModeRoot)
    for (const root of malformedIntentRoots) await deleteRoot(root)
    for (const root of callerCreationCrashRoots) await deleteRoot(root)
    for (const root of generatedCreationCrashRoots) await deleteRoot(root)
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
