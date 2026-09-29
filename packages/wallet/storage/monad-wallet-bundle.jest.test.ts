import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { spawn, spawnSync } from 'child_process'
import { Transaction, Wallet, computeAddress, getBytes, hexlify } from 'ethers'
import level from 'level'
import axios from 'axios'

import {
  MonadStampClient,
  buildMonadStampCalldata,
  computeMonadStampCommitment,
  computeMonadStampPaymentCommitment,
  decodeMonadStampedMessage,
  encodeMonadStampedMessage,
} from '../monad-stamp-client'
import { MonadHdKeyring } from '../monad-hd-keyring'
import { MonadChangeKeyring } from '../monad-change-keyring'
import { createMonadStampWalletHandle } from '../monad-wallet-handle'
import { deriveMonadStampChildPublic } from '../monad-stamp-stealth'
import { LevelChangePoolStore } from './level-change-pool-store'
import { LevelSubAccountPoolStore } from './level-sub-account-pool-store'
import { LevelStampAttemptJournal } from './stamp-attempt-journal'
import { LevelStampPaymentJournal } from './stamp-payment-journal'
import {
  acquireNodeWalletRootLease,
  nodeAdvisoryLockCommand,
  type NodeWalletCreationPhase,
} from './wallet-root-guard'
import {
  MonadWalletOrphanedAccountError,
  createInMemoryMonadWalletBundle,
  openMonadWalletBundle,
} from './monad-wallet-bundle'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

const FIRST_MNEMONIC =
  'test test test test test test test test test test test junk'
const SECOND_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

async function createLegacyRoot(
  location: string,
  withRecord = true
): Promise<void> {
  const keyring = MonadHdKeyring.fromMnemonic(FIRST_MNEMONIC)
  const sub = new LevelSubAccountPoolStore(location)
  const change = new LevelChangePoolStore(location)
  const attempts = new LevelStampAttemptJournal(location)
  const payments = new LevelStampPaymentJournal(location)
  await sub.Open()
  if (withRecord) {
    for (let index = 0; index <= 7; index++) {
      sub.put({
        index,
        address: keyring.deriveSubAccount(index).address,
        status: 'unfunded',
      })
    }
  }
  await sub.Close()
  await change.Open()
  await change.Close()
  await attempts.Open()
  await attempts.Close()
  await payments.Open()
  await payments.Close()
}

async function createNewCallerSeedRoot(location: string) {
  rmSync(location, { recursive: true, force: true })
  return openMonadWalletBundle({
    location,
    seed: { mnemonic: FIRST_MNEMONIC },
    mode: 'create',
  })
}

async function createNewGeneratedSeedRoot(location: string) {
  rmSync(location, { recursive: true, force: true })
  return openMonadWalletBundle({ location, createSeedIfEmpty: true })
}

function creationStages(location: string): string[] {
  const parent = dirname(location)
  const prefix = `.${basename(location)}.frank-wallet-create.`
  return readdirSync(parent)
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => join(parent, entry))
}

function creationCleanupArtifacts(location: string): string[] {
  const parent = dirname(location)
  const prefix = `.${basename(location)}.frank-wallet-cleanup.`
  return readdirSync(parent)
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => join(parent, entry))
}

function creationLock(location: string): string {
  return join(
    dirname(location),
    `.${basename(location)}.frank-wallet-creation.lock`
  )
}

const creationCleanupCrashPhases = [
  'before-claim-retirement',
  'claim-retired',
  'tombstone-intent-unlinked',
  'tombstone-identity-unlinked',
  'tombstone-removed',
  'root-intent-unlinked',
] as const

async function createSignedLegacyAttempt(location: string): Promise<{
  recipientPublicKeyHex: string
  messageBytes: number[]
  payloadHashHex: string
}> {
  const keyring = MonadHdKeyring.fromMnemonic(FIRST_MNEMONIC)
  const sender = keyring.deriveSubAccount(0)
  const payload = new TextEncoder().encode('legacy retained envelope')
  const payloadHash = computeMonadStampCommitment(payload)
  const recipientPublicKeyHex =
    Wallet.createRandom().signingKey.compressedPublicKey
  const destination = deriveMonadStampChildPublic({
    payloadHash,
    recipientPublicKey: getBytes(recipientPublicKeyHex),
    paymentIndex: 0,
  }).address
  const rawTx = await new Wallet(sender.privateKey).signTransaction({
    to: destination,
    value: 5n,
    data: buildMonadStampCalldata(
      computeMonadStampPaymentCommitment(payloadHash, 0)
    ),
    nonce: 0,
    gasLimit: 50_000n,
    gasPrice: 1n,
    chainId: 1,
  })
  const messageBytes = Array.from(
    encodeMonadStampedMessage({
      stampPayments: [{ childIndex: 0, rawTx: getBytes(rawTx) }],
      encryptedPayload: payload,
      payloadHash,
    })
  )
  const sub = new LevelSubAccountPoolStore(location)
  await sub.Open()
  sub.put({
    index: 0,
    address: sender.address,
    status: 'in-use',
    lifecycle: {
      spend: {
        rawTx,
        txHash: Transaction.from(rawTx).hash as string,
        valueWei: '5',
      },
    },
  })
  await sub.Close()
  const attempts = new LevelStampAttemptJournal(location)
  await attempts.Open()
  const payloadHashHex = hexlify(payloadHash).slice(2)
  await attempts.put({ payloadHashHex, messageBytes, leaseIndices: [0] })
  await attempts.Close()
  return { recipientPublicKeyHex, messageBytes, payloadHashHex }
}

async function createLegacyFinalizedRows(location: string) {
  const subKeyring = MonadHdKeyring.fromMnemonic(FIRST_MNEMONIC)
  const changeKeyring = MonadChangeKeyring.fromMnemonic(FIRST_MNEMONIC)
  const sender = subKeyring.deriveSubAccount(0)
  const change = changeKeyring.deriveChangeAccount(0)
  const fundingRaw = await Wallet.createRandom().signTransaction({
    to: sender.address,
    value: 100n,
    nonce: 0,
    gasLimit: 21_000n,
    gasPrice: 1n,
    chainId: 1,
  })
  const spendRaw = await new Wallet(sender.privateKey).signTransaction({
    to: Wallet.createRandom().address,
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
  const { rawTx: _discardedChangeRaw, ...legacyChange } = changeRecord
  await rawChange.put('0', JSON.stringify(legacyChange))
  await rawChange.close()

  const recipientPublicKeyHex =
    Wallet.createRandom().signingKey.compressedPublicKey
  const envelopeRecipientAddress = computeAddress(recipientPublicKeyHex)
  const payloadHash = computeMonadStampCommitment(
    new TextEncoder().encode('legacy recipient payment')
  )
  const destination = deriveMonadStampChildPublic({
    payloadHash,
    recipientPublicKey: getBytes(recipientPublicKeyHex),
    paymentIndex: 0,
  }).address
  const paymentRaw = await Wallet.createRandom().signTransaction({
    to: destination,
    value: 7n,
    data: buildMonadStampCalldata(
      computeMonadStampPaymentCommitment(payloadHash, 0)
    ),
    nonce: 0,
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
    rawTx: _discardedPaymentRaw,
    recipientPublicKeyHex: _discardedRecipient,
    envelopeRecipientAddress: _discardedEnvelope,
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

function storedMessageBytes(messageBytes: readonly number[]): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jspb = require('google-protobuf')
  const writer = new jspb.BinaryWriter()
  writer.writeBytes(1, Uint8Array.from(messageBytes))
  writer.writeInt64(4, 1_700_000_000_000)
  return writer.getResultBuffer()
}

describe('Monad wallet persistence bundle', () => {
  it('selects fail-closed advisory ownership primitives by Node platform', () => {
    expect(nodeAdvisoryLockCommand('darwin', '/lock', 'hold')).toMatchObject({
      command: '/usr/bin/lockf',
    })
    expect(nodeAdvisoryLockCommand('linux', '/lock', 'hold')).toMatchObject({
      command: '/usr/bin/flock',
      args: expect.arrayContaining(['-F']),
    })
    expect(() => nodeAdvisoryLockCommand('win32', '/lock', 'hold')).toThrow(
      /unsupported/i
    )
  })
  let root: string

  beforeEach(() => {
    mockedAxios.mockReset()
    root = mkdtempSync(join(tmpdir(), 'monad-wallet-bundle-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    for (const stage of creationStages(root)) {
      rmSync(stage, { recursive: true, force: true })
    }
    for (const cleanup of creationCleanupArtifacts(root)) {
      rmSync(cleanup, { recursive: true, force: true })
    }
    rmSync(creationLock(root), { force: true })
  })

  it('creates and reopens one complete bound bundle', async () => {
    const first = await createNewCallerSeedRoot(root)
    first.pool.ensureUnfundedSize(2)
    await first.pool.flush()
    const bindingId = first.bindingId
    const addresses = first.pool.records().map((record) => record.address)
    await first.close()

    const reopened = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
    })
    expect(reopened.bindingId).toBe(bindingId)
    expect(reopened.pool.records().map((record) => record.address)).toEqual(
      addresses
    )
    await reopened.close()
  })

  it('atomically creates a seed only for an empty root and reopens it', async () => {
    const first = await createNewGeneratedSeedRoot(root)
    const firstAddress = first.pool.deriveNextUnfunded().address
    await first.pool.flush()
    await first.close()

    const reopened = await openMonadWalletBundle({
      location: root,
      createSeedIfEmpty: true,
    })
    expect(reopened.pool.getRecord(0)?.address).toBe(firstAddress)
    await reopened.close()
  })

  it('treats semantically empty pre-manifest component stores as an empty restore and writes nothing', async () => {
    await createLegacyRoot(root, false)

    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
      })
    ).rejects.toThrow(/state backup|new seed|allocation ledger/i)

    expect(existsSync(join(root, 'wallet-manifest'))).toBe(false)
    for (const component of [
      'sub-account-pool',
      'change-pool',
      'outgoing-stamp-attempts',
      'stamp-payment-journal',
    ]) {
      const raw = level(join(root, component), { createIfMissing: false })
      const entries: unknown[] = []
      for await (const entry of raw.iterator({}) as never) entries.push(entry)
      await raw.close()
      expect(entries).toEqual([])
    }
  })

  it('rejects impossible creation discriminants before touching the filesystem', async () => {
    const untouched = join(root, 'invalid-mode-root')
    await expect(
      openMonadWalletBundle({
        location: untouched,
        seed: { mnemonic: FIRST_MNEMONIC },
        mode: 'create',
        createSeedIfEmpty: true,
      } as never)
    ).rejects.toThrow(/creation\/restore mode/i)
    expect(existsSync(untouched)).toBe(false)
  })

  it('rejects a missing restore root without creating its directory or lock', async () => {
    rmSync(root, { recursive: true, force: true })
    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
      })
    ).rejects.toThrow(/missing Node root/i)
    expect(existsSync(root)).toBe(false)

    const created = await createNewCallerSeedRoot(root)
    await created.close()
  })

  it.each([
    'staged',
    'temp-written',
    'temp-synced',
    'intent-published',
    'before-root-publish',
    'root-published',
    'intent-linked',
  ] as const)(
    'resumes exact first-use creation after a %s publication crash',
    async (phase) => {
      rmSync(root, { recursive: true, force: true })
      await expect(
        openMonadWalletBundle({
          location: root,
          seed: { mnemonic: FIRST_MNEMONIC },
          mode: 'create',
          onNodeCreationPublishPhase: (current) => {
            if (current === phase) throw new Error(`publish:${phase}`)
          },
        })
      ).rejects.toThrow(`publish:${phase}`)

      const resumed = await openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
        mode: 'create',
      })
      expect(resumed.pool.nextUnusedIndex()).toBe(0)
      await resumed.close()
      expect(creationStages(root)).toEqual([])
    }
  )

  it('rejects a wrong seed against an abandoned durable creation intent', async () => {
    rmSync(root, { recursive: true, force: true })
    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
        mode: 'create',
        onNodeCreationPublishPhase: (phase) => {
          if (phase === 'intent-published') throw new Error('intent crash')
        },
      })
    ).rejects.toThrow('intent crash')
    expect(existsSync(root)).toBe(false)

    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: SECOND_MNEMONIC },
        mode: 'create',
      })
    ).rejects.toThrow(/intent does not match/i)
    expect(existsSync(root)).toBe(false)
  })

  it('rejects a wrong seed after root publication without touching the empty claimed root', async () => {
    rmSync(root, { recursive: true, force: true })
    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
        mode: 'create',
        onNodeCreationPublishPhase: (phase) => {
          if (phase === 'root-published') throw new Error('claimed root crash')
        },
      })
    ).rejects.toThrow('claimed root crash')
    expect(readdirSync(root)).toEqual([])
    expect(creationStages(root)).toHaveLength(1)

    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: SECOND_MNEMONIC },
        mode: 'create',
      })
    ).rejects.toThrow(/intent does not match/i)
    expect(readdirSync(root)).toEqual([])
    expect(creationStages(root)).toHaveLength(1)

    const resumed = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
      mode: 'create',
    })
    await resumed.close()
  })

  it('rejects an empty replacement root after the original inode was bound', async () => {
    rmSync(root, { recursive: true, force: true })
    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
        mode: 'create',
        onNodeCreationPublishPhase: (phase) => {
          if (phase === 'root-published') throw new Error('bound root crash')
        },
      })
    ).rejects.toThrow('bound root crash')
    const original = lstatSync(root)
    const displaced = `${root}-bound-original`
    rmSync(displaced, { recursive: true, force: true })
    renameSync(root, displaced)
    mkdirSync(root, { mode: 0o700 })
    const replacement = lstatSync(root)
    expect(replacement.ino).not.toBe(original.ino)

    try {
      await expect(
        openMonadWalletBundle({
          location: root,
          seed: { mnemonic: FIRST_MNEMONIC },
          mode: 'create',
        })
      ).rejects.toThrow(/identity does not match creation claim/i)
      expect(readdirSync(root)).toEqual([])
      expect(lstatSync(root).ino).toBe(replacement.ino)
    } finally {
      rmSync(displaced, { recursive: true, force: true })
    }
  })

  it('rejects a normally returning root-published hook that swaps the claimed inode', async () => {
    rmSync(root, { recursive: true, force: true })
    const displaced = `${root}-hook-original`
    rmSync(displaced, { recursive: true, force: true })
    let replacementIdentity: ReturnType<typeof lstatSync> | undefined
    try {
      await expect(
        openMonadWalletBundle({
          location: root,
          seed: { mnemonic: FIRST_MNEMONIC },
          mode: 'create',
          onNodeCreationPublishPhase: (phase) => {
            if (phase !== 'root-published') return
            renameSync(root, displaced)
            mkdirSync(root, { mode: 0o700 })
            writeFileSync(join(root, 'competitor-owned'), 'untouched', {
              mode: 0o600,
            })
            replacementIdentity = lstatSync(root)
          },
        })
      ).rejects.toThrow(/identity changed after publication/i)
      expect(readFileSync(join(root, 'competitor-owned'), 'utf8')).toBe(
        'untouched'
      )
      expect(lstatSync(root).ino).toBe(replacementIdentity?.ino)
      expect(readdirSync(root)).toEqual(['competitor-owned'])
    } finally {
      rmSync(displaced, { recursive: true, force: true })
    }
  })

  it('rejects a copied creation intent in a replacement inode', async () => {
    rmSync(root, { recursive: true, force: true })
    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
        mode: 'create',
        onMigrationPhase: (phase) => {
          if (phase === 'creation-intent') throw new Error('intent boundary')
        },
      })
    ).rejects.toThrow('intent boundary')
    const retained = readFileSync(
      join(root, '.frank-wallet-creation.json'),
      'utf8'
    )
    const displaced = `${root}-intent-original`
    rmSync(displaced, { recursive: true, force: true })
    renameSync(root, displaced)
    mkdirSync(root, { mode: 0o700 })
    writeFileSync(join(root, '.frank-wallet-creation.json'), retained, {
      mode: 0o600,
    })
    const replacementIdentity = lstatSync(root)
    const replacementEntries = readdirSync(root)
    try {
      await expect(
        openMonadWalletBundle({
          location: root,
          seed: { mnemonic: FIRST_MNEMONIC },
          mode: 'create',
        })
      ).rejects.toThrow(/link authority|identity|owner-only regular file/i)
      expect(lstatSync(root).ino).toBe(replacementIdentity.ino)
      expect(readdirSync(root)).toEqual(replacementEntries)
      expect(
        readFileSync(join(root, '.frank-wallet-creation.json'), 'utf8')
      ).toBe(retained)
    } finally {
      rmSync(displaced, { recursive: true, force: true })
    }
  })

  it.each(
    (['caller', 'generated'] as const).flatMap((kind) =>
      creationCleanupCrashPhases.map((phase) => [kind, phase] as const)
    )
  )(
    'resumes exact %s creation after %s cleanup crash',
    async (kind, crashPhase) => {
      rmSync(root, { recursive: true, force: true })
      const crash = (phase: NodeWalletCreationPhase) => {
        if (phase === crashPhase) throw new Error(`cleanup:${crashPhase}`)
      }
      await expect(
        kind === 'caller'
          ? openMonadWalletBundle({
              location: root,
              seed: { mnemonic: FIRST_MNEMONIC },
              mode: 'create',
              onNodeCreationPublishPhase: crash,
            })
          : openMonadWalletBundle({
              location: root,
              createSeedIfEmpty: true,
              onNodeCreationPublishPhase: crash,
            })
      ).rejects.toThrow(`cleanup:${crashPhase}`)
      expect(existsSync(root)).toBe(true)
      const hasRetainedClaim =
        crashPhase === 'before-claim-retirement' ||
        crashPhase === 'claim-retired' ||
        crashPhase === 'tombstone-intent-unlinked' ||
        crashPhase === 'tombstone-identity-unlinked'
      expect(
        creationStages(root).length + creationCleanupArtifacts(root).length
      ).toBe(hasRetainedClaim ? 1 : 0)
      const rootIntent = join(root, '.frank-wallet-creation.json')
      expect(existsSync(rootIntent)).toBe(crashPhase !== 'root-intent-unlinked')
      const [retainedClaim] = [
        ...creationStages(root),
        ...creationCleanupArtifacts(root),
      ]
      const expectedClaimEntries =
        crashPhase === 'before-claim-retirement' ||
        crashPhase === 'claim-retired'
          ? ['.frank-wallet-creation.json', '.frank-wallet-root-identity.json']
          : crashPhase === 'tombstone-intent-unlinked'
          ? ['.frank-wallet-root-identity.json']
          : crashPhase === 'tombstone-identity-unlinked'
          ? []
          : undefined
      if (expectedClaimEntries !== undefined) {
        expect(readdirSync(retainedClaim).sort()).toEqual(expectedClaimEntries)
      }
      if (crashPhase !== 'root-intent-unlinked') {
        expect(lstatSync(rootIntent).nlink).toBe(
          crashPhase === 'before-claim-retirement' ||
            crashPhase === 'claim-retired'
            ? 2
            : 1
        )
      }

      const resumed =
        kind === 'caller'
          ? await openMonadWalletBundle({
              location: root,
              seed: { mnemonic: FIRST_MNEMONIC },
              mode: 'create',
            })
          : await openMonadWalletBundle({
              location: root,
              createSeedIfEmpty: true,
            })
      expect(resumed.pool.nextUnusedIndex()).toBe(0)
      await resumed.close()
      expect(creationStages(root)).toEqual([])
      expect(creationCleanupArtifacts(root)).toEqual([])
      expect(existsSync(join(root, '.frank-wallet-creation.json'))).toBe(false)
    }
  )

  it.each(['caller', 'generated'] as const)(
    'leaves a retired %s claim untouched for a wrong seed or creation mode',
    async (kind) => {
      rmSync(root, { recursive: true, force: true })
      const crashAtRetirement = (phase: NodeWalletCreationPhase) => {
        if (phase === 'claim-retired') throw new Error('retired boundary')
      }
      await expect(
        kind === 'caller'
          ? openMonadWalletBundle({
              location: root,
              seed: { mnemonic: FIRST_MNEMONIC },
              mode: 'create',
              onNodeCreationPublishPhase: crashAtRetirement,
            })
          : openMonadWalletBundle({
              location: root,
              createSeedIfEmpty: true,
              onNodeCreationPublishPhase: crashAtRetirement,
            })
      ).rejects.toThrow('retired boundary')
      const [cleanup] = creationCleanupArtifacts(root)
      const rootIntentPath = join(root, '.frank-wallet-creation.json')
      const beforeIntent = readFileSync(rootIntentPath)
      const beforeEntries = readdirSync(cleanup).sort()
      const beforeFiles = beforeEntries.map((entry) =>
        readFileSync(join(cleanup, entry))
      )

      const incompatible =
        kind === 'caller'
          ? [
              () =>
                openMonadWalletBundle({
                  location: root,
                  seed: { mnemonic: SECOND_MNEMONIC },
                  mode: 'create',
                }),
              () =>
                openMonadWalletBundle({
                  location: root,
                  createSeedIfEmpty: true,
                }),
            ]
          : [
              () =>
                openMonadWalletBundle({
                  location: root,
                  seed: { mnemonic: FIRST_MNEMONIC },
                  mode: 'create',
                }),
            ]
      for (const attempt of incompatible) {
        await expect(attempt()).rejects.toThrow(/seed|intent|generated/i)
        expect(readFileSync(rootIntentPath)).toEqual(beforeIntent)
        expect(readdirSync(cleanup).sort()).toEqual(beforeEntries)
        for (const [index, entry] of beforeEntries.entries()) {
          expect(readFileSync(join(cleanup, entry))).toEqual(beforeFiles[index])
        }
      }

      const resumed =
        kind === 'caller'
          ? await openMonadWalletBundle({
              location: root,
              seed: { mnemonic: FIRST_MNEMONIC },
              mode: 'create',
            })
          : await openMonadWalletBundle({
              location: root,
              createSeedIfEmpty: true,
            })
      await resumed.close()
    }
  )

  it.each(['caller', 'generated'] as const)(
    'recovers the identity-only legacy %s cleanup prefix',
    async (kind) => {
      rmSync(root, { recursive: true, force: true })
      const stopBeforeRetirement = (phase: NodeWalletCreationPhase) => {
        if (phase === 'before-claim-retirement') {
          throw new Error('retain active claim')
        }
      }
      await expect(
        kind === 'caller'
          ? openMonadWalletBundle({
              location: root,
              seed: { mnemonic: FIRST_MNEMONIC },
              mode: 'create',
              onNodeCreationPublishPhase: stopBeforeRetirement,
            })
          : openMonadWalletBundle({
              location: root,
              createSeedIfEmpty: true,
              onNodeCreationPublishPhase: stopBeforeRetirement,
            })
      ).rejects.toThrow('retain active claim')
      const [stage] = creationStages(root)
      rmSync(join(root, '.frank-wallet-creation.json'))
      rmSync(join(stage, '.frank-wallet-creation.json'))
      expect(readdirSync(stage)).toEqual(['.frank-wallet-root-identity.json'])

      let generatedSeed: { mnemonic: string; passphrase: string } | undefined
      if (kind === 'generated') {
        const manifest = level(join(root, 'wallet-manifest'), {
          createIfMissing: false,
        })
        generatedSeed = JSON.parse(await manifest.get('seed'))
        await manifest.close()
      }
      await expect(
        kind === 'caller'
          ? openMonadWalletBundle({
              location: root,
              createSeedIfEmpty: true,
            })
          : openMonadWalletBundle({
              location: root,
              seed: generatedSeed,
              mode: 'create',
            })
      ).rejects.toThrow(/exact original creation mode/i)
      expect(readdirSync(stage)).toEqual(['.frank-wallet-root-identity.json'])

      const resumed =
        kind === 'caller'
          ? await openMonadWalletBundle({
              location: root,
              seed: { mnemonic: FIRST_MNEMONIC },
              mode: 'create',
            })
          : await openMonadWalletBundle({
              location: root,
              createSeedIfEmpty: true,
            })
      await resumed.close()
      expect(creationStages(root)).toEqual([])
      expect(creationCleanupArtifacts(root)).toEqual([])
    }
  )

  it.each([
    'directory symlink',
    'weak directory permissions',
    'identity FIFO',
    'identity symlink',
    'overlinked identity',
    'unowned directory',
  ] as const)(
    'rejects a retired creation claim with a hostile %s without clearing root intent',
    async (variant) => {
      rmSync(root, { recursive: true, force: true })
      await expect(
        openMonadWalletBundle({
          location: root,
          seed: { mnemonic: FIRST_MNEMONIC },
          mode: 'create',
          onNodeCreationPublishPhase: (phase) => {
            if (phase === 'claim-retired') throw new Error('retained tombstone')
          },
        })
      ).rejects.toThrow('retained tombstone')
      const [cleanup] = creationCleanupArtifacts(root)
      const identity = join(cleanup, '.frank-wallet-root-identity.json')
      const outside = `${root}-hostile-cleanup`
      let lstatSpy: jest.SpyInstance | undefined
      rmSync(outside, { recursive: true, force: true })
      if (variant === 'directory symlink') {
        renameSync(cleanup, outside)
        symlinkSync(outside, cleanup)
      } else if (variant === 'weak directory permissions') {
        chmodSync(cleanup, 0o755)
      } else if (variant === 'identity FIFO') {
        rmSync(identity)
        expect(spawnSync('mkfifo', [identity]).status).toBe(0)
        chmodSync(identity, 0o600)
      } else if (variant === 'identity symlink') {
        rmSync(identity)
        symlinkSync(join(root, '.frank-wallet-creation.json'), identity)
      } else if (variant === 'overlinked identity') {
        linkSync(identity, outside)
      } else {
        const realLstatSync = require('fs').lstatSync
        lstatSpy = jest
          .spyOn(require('fs'), 'lstatSync')
          .mockImplementation((path: string) => {
            const stat = realLstatSync(path)
            if (path === cleanup) {
              Object.defineProperty(stat, 'uid', {
                value: (process.getuid?.() ?? stat.uid) + 1,
              })
            }
            return stat
          })
      }

      try {
        await expect(
          openMonadWalletBundle({
            location: root,
            seed: { mnemonic: FIRST_MNEMONIC },
            mode: 'create',
          })
        ).rejects.toThrow(
          /private directory|owner-only regular file|owned by the current user/i
        )
        expect(existsSync(join(root, '.frank-wallet-creation.json'))).toBe(true)
      } finally {
        lstatSpy?.mockRestore()
        rmSync(outside, { recursive: true, force: true })
      }
    }
  )

  it('rejects a copied intent in a replacement root while a retired inode claim exists', async () => {
    rmSync(root, { recursive: true, force: true })
    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
        mode: 'create',
        onNodeCreationPublishPhase: (phase) => {
          if (phase === 'claim-retired') throw new Error('retired replacement')
        },
      })
    ).rejects.toThrow('retired replacement')
    const retained = readFileSync(
      join(root, '.frank-wallet-creation.json'),
      'utf8'
    )
    const displaced = `${root}-retired-original`
    rmSync(displaced, { recursive: true, force: true })
    renameSync(root, displaced)
    mkdirSync(root, { mode: 0o700 })
    writeFileSync(join(root, '.frank-wallet-creation.json'), retained, {
      mode: 0o600,
    })
    const replacementIdentity = lstatSync(root)
    try {
      await expect(
        openMonadWalletBundle({
          location: root,
          seed: { mnemonic: FIRST_MNEMONIC },
          mode: 'create',
        })
      ).rejects.toThrow(/identity does not match cleanup claim/i)
      expect(lstatSync(root).ino).toBe(replacementIdentity.ino)
      expect(readdirSync(root)).toEqual(['.frank-wallet-creation.json'])
      expect(
        readFileSync(join(root, '.frank-wallet-creation.json'), 'utf8')
      ).toBe(retained)
    } finally {
      rmSync(displaced, { recursive: true, force: true })
    }
  })

  it('rejects a root-only intent backed by an unfinalized manifest database', async () => {
    rmSync(root, { recursive: true, force: true })
    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
        mode: 'create',
        onNodeCreationPublishPhase: (phase) => {
          if (phase === 'intent-linked') throw new Error('retain root intent')
        },
      })
    ).rejects.toThrow('retain root intent')
    for (const stage of creationStages(root)) {
      rmSync(stage, { recursive: true, force: true })
    }
    const fakeManifest = level(join(root, 'wallet-manifest'))
    await fakeManifest.open()
    await fakeManifest.close()
    const intentPath = join(root, '.frank-wallet-creation.json')
    const retainedIntent = readFileSync(intentPath)

    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
        mode: 'create',
      })
    ).rejects.toThrow(/neither.*claim nor a finalized wallet manifest/i)
    expect(readFileSync(intentPath)).toEqual(retainedIntent)
    expect(existsSync(join(root, 'sub-account-pool'))).toBe(false)
  })

  it.each([
    ['same seed', FIRST_MNEMONIC],
    ['different seed', SECOND_MNEMONIC],
  ])(
    'serializes concurrent %s creators before root publication',
    async (_description, contenderMnemonic) => {
      rmSync(root, { recursive: true, force: true })
      let entered!: () => void
      let resume!: () => void
      const atBarrier = new Promise<void>((resolve) => {
        entered = resolve
      })
      const barrier = new Promise<void>((resolve) => {
        resume = resolve
      })
      const creator = openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
        mode: 'create',
        onNodeCreationPublishPhase: async (phase) => {
          if (phase === 'before-root-publish') {
            entered()
            await barrier
          }
        },
      })
      await atBarrier
      expect(existsSync(root)).toBe(false)
      expect(creationStages(root)).toHaveLength(1)

      await expect(
        openMonadWalletBundle({
          location: root,
          seed: { mnemonic: contenderMnemonic },
          mode: 'create',
        })
      ).rejects.toThrow(/creation is already active/i)
      expect(existsSync(root)).toBe(false)
      expect(creationStages(root)).toHaveLength(1)

      resume()
      const created = await creator
      await created.close()
      expect(creationStages(root)).toEqual([])
      const reopened = await openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
      })
      await reopened.close()
    }
  )

  it('does not mutate a competing root that appears at the publication barrier', async () => {
    rmSync(root, { recursive: true, force: true })
    let entered!: () => void
    let resume!: () => void
    const atBarrier = new Promise<void>((resolve) => {
      entered = resolve
    })
    const barrier = new Promise<void>((resolve) => {
      resume = resolve
    })
    const creator = openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
      mode: 'create',
      onNodeCreationPublishPhase: async (phase) => {
        if (phase === 'before-root-publish') {
          entered()
          await barrier
        }
      },
    })
    await atBarrier
    mkdirSync(root, { mode: 0o700 })
    const sentinel = join(root, 'competitor-owned')
    writeFileSync(sentinel, 'untouched', { mode: 0o600 })
    const before = readFileSync(sentinel)
    resume()

    await expect(creator).rejects.toThrow(/appeared before atomic/i)
    expect(readFileSync(sentinel)).toEqual(before)
    expect(readdirSync(root)).toEqual(['competitor-owned'])
    expect(creationStages(root)).toHaveLength(1)

    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
        mode: 'create',
      })
    ).rejects.toThrow(
      /missing Node root|not bound to the durable creation claim/i
    )
    expect(readFileSync(sentinel)).toEqual(before)
    expect(readdirSync(root)).toEqual(['competitor-owned'])
  })

  it('never adopts an empty competing root after a creation claim is staged', async () => {
    rmSync(root, { recursive: true, force: true })
    let entered!: () => void
    let resume!: () => void
    const atBarrier = new Promise<void>((resolve) => {
      entered = resolve
    })
    const barrier = new Promise<void>((resolve) => {
      resume = resolve
    })
    const creator = openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
      mode: 'create',
      onNodeCreationPublishPhase: async (phase) => {
        if (phase === 'before-root-publish') {
          entered()
          await barrier
        }
      },
    })
    await atBarrier
    mkdirSync(root, { mode: 0o700 })
    const competitorIdentity = lstatSync(root)
    resume()

    await expect(creator).rejects.toThrow(/appeared before atomic/i)
    expect(readdirSync(root)).toEqual([])
    expect(lstatSync(root).dev).toBe(competitorIdentity.dev)
    expect(lstatSync(root).ino).toBe(competitorIdentity.ino)
    expect(creationStages(root)).toHaveLength(1)

    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
        mode: 'create',
      })
    ).rejects.toThrow(/not bound to the durable creation claim/i)
    expect(readdirSync(root)).toEqual([])
    expect(lstatSync(root).dev).toBe(competitorIdentity.dev)
    expect(lstatSync(root).ino).toBe(competitorIdentity.ino)
  })

  it.each([
    'creation-intent',
    'validated',
    'marker',
    'sub-account-pool',
    'change-pool',
    'outgoing-stamp-attempts',
    'stamp-payment-journal',
    'manifest',
  ] as const)(
    'resumes the exact caller-seed creation intent after a %s crash',
    async (phase) => {
      rmSync(root, { recursive: true, force: true })
      await expect(
        openMonadWalletBundle({
          location: root,
          seed: { mnemonic: FIRST_MNEMONIC },
          mode: 'create',
          onMigrationPhase: async (current) => {
            if (current === phase) throw new Error(`crash at ${phase}`)
          },
        })
      ).rejects.toThrow(`crash at ${phase}`)

      const intentPath = join(root, '.frank-wallet-creation.json')
      if (existsSync(intentPath)) {
        expect(readFileSync(intentPath, 'utf8')).not.toContain(FIRST_MNEMONIC)
      }
      await expect(
        openMonadWalletBundle({
          location: root,
          seed: { mnemonic: SECOND_MNEMONIC },
          mode: 'create',
        })
      ).rejects.toThrow(/seed does not match/i)

      const resumed = await openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
        mode: 'create',
      })
      expect(resumed.pool.nextUnusedIndex()).toBe(0)
      await resumed.close()
      expect(existsSync(intentPath)).toBe(false)
    }
  )

  it.each([
    [
      'bindingId',
      (marker: Record<string, unknown>) => ({
        ...marker,
        bindingId: 'aa'.repeat(32),
      }),
    ],
    [
      'seedFingerprint',
      (marker: Record<string, unknown>) => ({
        ...marker,
        seedFingerprint: `0x${'aa'.repeat(32)}`,
      }),
    ],
    [
      'creationMode',
      (marker: Record<string, unknown>) => ({
        ...marker,
        creationMode: undefined,
      }),
    ],
    [
      'persistedSeed',
      (marker: Record<string, unknown>) => ({
        ...marker,
        persistedSeed: {
          version: 1,
          mnemonic: SECOND_MNEMONIC,
          passphrase: '',
        },
      }),
    ],
    [
      'restoreMode',
      (marker: Record<string, unknown>) => ({
        ...marker,
        restoreMode: true,
      }),
    ],
  ] as const)(
    'rejects creation-intent/migration-marker %s mismatch before component open',
    async (_field, mutate) => {
      rmSync(root, { recursive: true, force: true })
      await expect(
        openMonadWalletBundle({
          location: root,
          seed: { mnemonic: FIRST_MNEMONIC },
          mode: 'create',
          onMigrationPhase: async (phase) => {
            if (phase === 'marker') throw new Error('marker crash')
          },
        })
      ).rejects.toThrow('marker crash')

      const manifest = level(join(root, 'wallet-manifest'), {
        createIfMissing: false,
      })
      const marker = JSON.parse(await manifest.get('migration')) as Record<
        string,
        unknown
      >
      const poisonedMarker = JSON.stringify(mutate(marker))
      await manifest.put('migration', poisonedMarker)
      await manifest.close()
      const rootEntriesBefore = readdirSync(root).sort()

      await expect(
        openMonadWalletBundle({
          location: root,
          seed: { mnemonic: FIRST_MNEMONIC },
          mode: 'create',
        })
      ).rejects.toThrow(
        /intent does not match the migration marker|seed does not match the durable wallet/i
      )
      expect(readdirSync(root).sort()).toEqual(rootEntriesBefore)
      const reopenedManifest = level(join(root, 'wallet-manifest'), {
        createIfMissing: false,
      })
      await expect(reopenedManifest.get('migration')).resolves.toBe(
        poisonedMarker
      )
      await reopenedManifest.close()
    }
  )

  it('persists and resumes a generated seed only through its creation intent', async () => {
    rmSync(root, { recursive: true, force: true })
    await expect(
      openMonadWalletBundle({
        location: root,
        createSeedIfEmpty: true,
        onMigrationPhase: async (phase) => {
          if (phase === 'creation-intent') throw new Error('generated crash')
        },
      })
    ).rejects.toThrow(/generated crash/i)
    const intent = JSON.parse(
      readFileSync(join(root, '.frank-wallet-creation.json'), 'utf8')
    ) as { kind: string; persistedSeed?: { mnemonic?: string } }
    expect(intent.kind).toBe('generated')
    expect(intent.persistedSeed?.mnemonic).toBeTruthy()

    const resumed = await openMonadWalletBundle({
      location: root,
      createSeedIfEmpty: true,
    })
    await resumed.close()
    expect(existsSync(join(root, '.frank-wallet-creation.json'))).toBe(false)
  })

  it.each([
    'staged',
    'temp-written',
    'temp-synced',
    'intent-published',
    'before-root-publish',
    'root-published',
    'intent-linked',
  ] as const)(
    'recovers the original generated seed after a %s publication crash',
    async (phase) => {
      rmSync(root, { recursive: true, force: true })
      await expect(
        openMonadWalletBundle({
          location: root,
          createSeedIfEmpty: true,
          onNodeCreationPublishPhase: (current) => {
            if (current === phase) throw new Error(`generated:${phase}`)
          },
        })
      ).rejects.toThrow(`generated:${phase}`)

      const [stage] = creationStages(root)
      expect(stage).toBeDefined()
      const finalIntent = join(stage, '.frank-wallet-creation.json')
      const temporaryIntent = `${finalIntent}.tmp`
      const retained = JSON.parse(
        readFileSync(
          existsSync(finalIntent) ? finalIntent : temporaryIntent,
          'utf8'
        )
      ) as { persistedSeed: { mnemonic: string; passphrase: string } }
      const originalAddress = MonadHdKeyring.fromMnemonic(
        retained.persistedSeed.mnemonic,
        retained.persistedSeed.passphrase
      ).deriveSubAccount(0).address
      const generate = jest.spyOn(MonadHdKeyring, 'generate')
      try {
        const resumed = await openMonadWalletBundle({
          location: root,
          createSeedIfEmpty: true,
        })
        expect(generate).not.toHaveBeenCalled()
        expect(resumed.pool.deriveNextUnfunded().address).toBe(originalAddress)
        await resumed.pool.flush()
        await resumed.close()
      } finally {
        generate.mockRestore()
      }
      expect(creationStages(root)).toEqual([])
    }
  )

  it.each(['wrong-mode', 'corrupt', 'multiple'] as const)(
    'fails closed on a %s abandoned generated creation claim before generating again',
    async (variant) => {
      rmSync(root, { recursive: true, force: true })
      await expect(
        openMonadWalletBundle({
          location: root,
          createSeedIfEmpty: true,
          onNodeCreationPublishPhase: (phase) => {
            if (phase === 'intent-published')
              throw new Error('retain generated')
          },
        })
      ).rejects.toThrow('retain generated')
      const [stage] = creationStages(root)
      const intentPath = join(stage, '.frank-wallet-creation.json')
      const retained = readFileSync(intentPath, 'utf8')
      if (variant === 'wrong-mode') {
        const parsed = JSON.parse(retained) as Record<string, unknown>
        parsed.kind = 'caller-supplied'
        delete parsed.persistedSeed
        writeFileSync(intentPath, JSON.stringify(parsed), { mode: 0o600 })
      } else if (variant === 'corrupt') {
        writeFileSync(intentPath, '{', { mode: 0o600 })
      } else {
        const duplicate = mkdtempSync(
          join(dirname(root), `.${basename(root)}.frank-wallet-create.`)
        )
        chmodSync(duplicate, 0o700)
        writeFileSync(
          join(duplicate, '.frank-wallet-creation.json'),
          retained,
          { mode: 0o600 }
        )
      }

      const generate = jest.spyOn(MonadHdKeyring, 'generate')
      try {
        await expect(
          openMonadWalletBundle({ location: root, createSeedIfEmpty: true })
        ).rejects.toThrow(/intent|multiple|mode|authentication|JSON/i)
        expect(generate).not.toHaveBeenCalled()
      } finally {
        generate.mockRestore()
      }
      expect(existsSync(root)).toBe(false)
    }
  )

  it.each([
    ['final FIFO', '.frank-wallet-creation.json', false],
    ['temporary FIFO', '.frank-wallet-creation.json.tmp', false],
    ['final symlink to FIFO', '.frank-wallet-creation.json', true],
    ['temporary symlink to FIFO', '.frank-wallet-creation.json.tmp', true],
  ] as const)(
    'rejects an abandoned %s without blocking or creating the root',
    async (_description, fileName, useSymlink) => {
      rmSync(root, { recursive: true, force: true })
      const stage = mkdtempSync(
        join(dirname(root), `.${basename(root)}.frank-wallet-create.`)
      )
      chmodSync(stage, 0o700)
      const fifo = join(dirname(root), `.${basename(root)}.attacker-fifo`)
      rmSync(fifo, { force: true })
      expect(spawnSync('mkfifo', [fifo]).status).toBe(0)
      chmodSync(fifo, 0o600)
      const stagedPath = join(stage, fileName)
      if (useSymlink) symlinkSync(fifo, stagedPath)
      else renameSync(fifo, stagedPath)

      try {
        await expect(
          openMonadWalletBundle({
            location: root,
            seed: { mnemonic: FIRST_MNEMONIC },
            mode: 'create',
          })
        ).rejects.toThrow(/regular file|invalid size/i)
        expect(existsSync(root)).toBe(false)
      } finally {
        rmSync(fifo, { force: true })
      }
    }
  )

  it('rejects unbound counters plus unrelated payment evidence for every seed without binding', async () => {
    await createLegacyRoot(root, false)
    const counterStore = new LevelSubAccountPoolStore(root)
    await counterStore.Open()
    counterStore.setNextIndex(7)
    await counterStore.Close()

    const payloadHash = computeMonadStampCommitment(
      new TextEncoder().encode('unrelated retained payment')
    )
    const recipient = new Wallet(`0x${'44'.repeat(32)}`)
    const child = deriveMonadStampChildPublic({
      payloadHash,
      recipientPublicKey: getBytes(recipient.signingKey.compressedPublicKey),
      paymentIndex: 0,
    })
    const rawTx = await new Wallet(`0x${'55'.repeat(32)}`).signTransaction({
      to: child.address,
      value: 7n,
      data: buildMonadStampCalldata(
        computeMonadStampPaymentCommitment(payloadHash, 0)
      ),
      nonce: 0,
      gasLimit: 50_000n,
      gasPrice: 1n,
      chainId: 1,
    })
    const paymentJournal = new LevelStampPaymentJournal(root)
    await paymentJournal.Open()
    await paymentJournal.put({
      payloadHashHex: hexlify(payloadHash).slice(2),
      childIndex: 0,
      txHash: Transaction.from(rawTx).hash as string,
      rawTx,
      recipientPublicKeyHex: recipient.signingKey.compressedPublicKey,
      envelopeRecipientAddress: recipient.address,
      address: child.address,
      valueWei: '7',
      status: 'discovered',
    })
    await paymentJournal.Close()

    for (const mnemonic of [FIRST_MNEMONIC, SECOND_MNEMONIC]) {
      await expect(
        openMonadWalletBundle({
          location: root,
          seed: { mnemonic },
        })
      ).rejects.toThrow(/high-water domain.*authenticated/i)
    }
    expect(existsSync(join(root, 'wallet-manifest'))).toBe(false)
    const raw = level(join(root, 'sub-account-pool'), {
      createIfMissing: false,
    })
    const keys: string[] = []
    for await (const [key] of raw.iterator({}) as never) keys.push(key)
    await raw.close()
    expect(keys).not.toContain('__wallet_binding__')
  })

  it('accepts an explicit caller seed only for a storage root created by that acquisition', async () => {
    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
        mode: 'create',
      })
    ).rejects.toThrow(/exclusive acquisition/i)
    expect(existsSync(join(root, 'wallet-manifest'))).toBe(false)
    expect(readdirSync(root)).toEqual([])
    expect(existsSync(join(root, '.frank-wallet.lock'))).toBe(false)

    const created = await createNewCallerSeedRoot(root)
    expect(created.pool.deriveNextUnfunded().address).toBe(
      MonadHdKeyring.fromMnemonic(FIRST_MNEMONIC).deriveSubAccount(0).address
    )
    await created.pool.flush()
    await created.close()

    const reopened = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
      mode: 'create',
    })
    expect(reopened.pool.nextUnusedIndex()).toBe(1)
    await reopened.close()
  })

  it('keeps the root lease until an admitted payment operation drains during close', async () => {
    const bundle = await createNewCallerSeedRoot(root)
    let entered!: () => void
    let resume!: () => void
    let operationCompleted = false
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve
    })
    const pause = new Promise<void>((resolve) => {
      resume = resolve
    })
    const active = bundle.stampPaymentJournal.withPaymentLock(
      'ab'.repeat(32),
      0,
      async () => {
        entered()
        await pause
        operationCompleted = true
      }
    )
    await enteredPromise
    let closed = false
    const closing = bundle.close().then(() => {
      closed = true
    })
    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
      })
    ).rejects.toThrow(/already open/i)
    expect(closed).toBe(false)

    resume()
    await active
    await closing
    expect(operationCompleted).toBe(true)
    const successor = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
    })
    await successor.close()
  })

  it('rejects hostile empty-root allocation counts before network or durable writes', async () => {
    const provider = {
      getTransactionCount: jest.fn(async (address: string) =>
        address ===
        MonadHdKeyring.fromMnemonic(FIRST_MNEMONIC).deriveSubAccount(6).address
          ? 1
          : 0
      ),
      getBalance: jest.fn(async () => 0n),
    }
    const assertRelayAvailable = jest.fn(async () => undefined)
    const recoverAllocationHighWater = jest.fn(async () => ({
      // Hostile/stale authority claims only index zero was allocated despite later chain history.
      senderNextIndex: 1,
      changeNextIndex: 1,
    }))
    const recoverSenderEvidence = jest.fn(async () => undefined)

    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
        recovery: {
          provider: provider as never,
          maxIndex: 10,
          assertRelayAvailable,
          recoverAllocationHighWater,
          recoverSenderEvidence,
        } as never,
      })
    ).rejects.toThrow(/state backup|new seed|allocation ledger/i)

    expect(assertRelayAvailable).not.toHaveBeenCalled()
    expect(recoverAllocationHighWater).not.toHaveBeenCalled()
    expect(recoverSenderEvidence).not.toHaveBeenCalled()
    expect(provider.getTransactionCount).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'wallet-manifest'))).toBe(false)
    expect(existsSync(join(root, 'sub-account-pool'))).toBe(false)
  })

  it('adopts a complete valid legacy root and persists its inferred high-water mark', async () => {
    await createLegacyRoot(root)

    const migrated = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
    })
    expect(migrated.pool.nextUnusedIndex()).toBe(8)
    expect(migrated.pool.deriveNextUnfunded().index).toBe(8)
    await migrated.close()

    const reopened = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
    })
    expect(reopened.pool.nextUnusedIndex()).toBe(9)
    await reopened.close()
  })

  it('hardens an owner-valid legacy 0755 root before adopting it', async () => {
    await createLegacyRoot(root)
    chmodSync(root, 0o755)

    const migrated = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
    })
    expect(lstatSync(root).mode & 0o777).toBe(0o700)
    await migrated.close()
  })

  it('stages and durably upgrades authoritative legacy finalized rows', async () => {
    const legacy = await createLegacyFinalizedRows(root)
    const migrated = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
      resolveLegacyChangeRawTransaction: async () => legacy.changeRaw,
      resolveLegacyPaymentAuthority: async () => ({
        rawTx: legacy.paymentRaw,
        recipientPublicKeyHex: legacy.recipientPublicKeyHex,
        envelopeRecipientAddress: legacy.envelopeRecipientAddress,
      }),
    })
    expect(migrated.changePool.records()[0].rawTx).toBe(legacy.changeRaw)
    expect(
      migrated.stampPaymentJournal.get(legacy.payloadHashHex, 0)
    ).toMatchObject({
      rawTx: legacy.paymentRaw,
      recipientPublicKeyHex: legacy.recipientPublicKeyHex,
      envelopeRecipientAddress: legacy.envelopeRecipientAddress,
    })
    await migrated.close()

    const reopened = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
    })
    expect(reopened.changePool.records()[0].rawTx).toBe(legacy.changeRaw)
    expect(
      reopened.stampPaymentJournal.get(legacy.payloadHashHex, 0)?.rawTx
    ).toBe(legacy.paymentRaw)
    await reopened.close()
  })

  it('leaves legacy finalized rows untouched on authority outage or mismatch', async () => {
    const legacy = await createLegacyFinalizedRows(root)
    const rawChange = level(join(root, 'change-pool'))
    const beforeChange = await rawChange.get('0')
    await rawChange.close()
    const rawPayments = level(join(root, 'stamp-payment-journal'))
    const beforePayment = await rawPayments.get(`${legacy.payloadHashHex}:0`)
    await rawPayments.close()

    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
        resolveLegacyChangeRawTransaction: async () => {
          throw new Error('RPC unavailable')
        },
        resolveLegacyPaymentAuthority: async () => ({
          rawTx: legacy.paymentRaw,
          recipientPublicKeyHex: legacy.recipientPublicKeyHex,
          envelopeRecipientAddress: legacy.envelopeRecipientAddress,
        }),
      })
    ).rejects.toThrow(/RPC unavailable/)
    expect(existsSync(join(root, 'wallet-manifest'))).toBe(false)

    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
        resolveLegacyChangeRawTransaction: async () => legacy.paymentRaw,
        resolveLegacyPaymentAuthority: async () => ({
          rawTx: legacy.paymentRaw,
          recipientPublicKeyHex: legacy.recipientPublicKeyHex,
          envelopeRecipientAddress: legacy.envelopeRecipientAddress,
        }),
      })
    ).rejects.toThrow(/change|transaction|sender|destination/i)
    expect(existsSync(join(root, 'wallet-manifest'))).toBe(false)
    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
        resolveLegacyChangeRawTransaction: async () => legacy.changeRaw,
        resolveLegacyPaymentAuthority: async () => ({
          rawTx: legacy.changeRaw,
          recipientPublicKeyHex: legacy.recipientPublicKeyHex,
          envelopeRecipientAddress: legacy.envelopeRecipientAddress,
        }),
      })
    ).rejects.toThrow(/stamp-payment|transaction|destination/i)
    expect(existsSync(join(root, 'wallet-manifest'))).toBe(false)
    const checkChange = level(join(root, 'change-pool'))
    expect(await checkChange.get('0')).toBe(beforeChange)
    await checkChange.close()
    const checkPayment = level(join(root, 'stamp-payment-journal'))
    expect(await checkPayment.get(`${legacy.payloadHashHex}:0`)).toBe(
      beforePayment
    )
    await checkPayment.close()
  })

  it('resumes finalized-row migration after a component bind commits before its marker', async () => {
    const legacy = await createLegacyFinalizedRows(root)
    const resolvers = {
      resolveLegacyChangeRawTransaction: async () => legacy.changeRaw,
      resolveLegacyPaymentAuthority: async () => ({
        rawTx: legacy.paymentRaw,
        recipientPublicKeyHex: legacy.recipientPublicKeyHex,
        envelopeRecipientAddress: legacy.envelopeRecipientAddress,
      }),
    }
    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
        ...resolvers,
        onMigrationBind: (component) => {
          if (component === 'change-pool') throw new Error('crash:change-bind')
        },
      })
    ).rejects.toThrow('crash:change-bind')
    const resumed = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
      ...resolvers,
    })
    expect(resumed.changePool.records()[0].rawTx).toBe(legacy.changeRaw)
    expect(
      resumed.stampPaymentJournal.get(legacy.payloadHashHex, 0)?.rawTx
    ).toBe(legacy.paymentRaw)
    await resumed.close()
  })

  it('resolves and durably upgrades a real signed legacy attempt without changing its bytes', async () => {
    await createLegacyRoot(root, false)
    const legacy = await createSignedLegacyAttempt(root)
    const resolver = jest.fn(async () => legacy.recipientPublicKeyHex)

    const migrated = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
      resolveLegacyAttemptRecipientPublicKey: resolver,
    })
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(migrated.stampAttemptJournal.getAll()[0]).toMatchObject({
      payloadHashHex: legacy.payloadHashHex,
      messageBytes: legacy.messageBytes,
      recipientPublicKeyHex: legacy.recipientPublicKeyHex,
    })
    await migrated.repairAttemptSpendLifecycles()
    mockedAxios.mockImplementationOnce(async (config) => {
      expect(Array.from(new Uint8Array(config.data as Buffer))).toEqual(
        legacy.messageBytes
      )
      const decoded = decodeMonadStampedMessage(
        new Uint8Array(config.data as Buffer)
      )
      return {
        data: storedMessageBytes(
          Array.from(encodeMonadStampedMessage(decoded))
        ),
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    })
    const client = new MonadStampClient(
      createMonadStampWalletHandle({
        walletState: migrated,
        provider: {
          getBalance: async () => 0n,
          getFeeData: async () => ({ gasPrice: 1n }),
        } as never,
        httpClient: {} as never,
        relayBaseUrl: 'https://relay.invalid',
      })
    )
    await expect(client.resumePendingAttempts()).resolves.toEqual([
      legacy.payloadHashHex,
    ])
    expect(migrated.stampAttemptJournal.getAll()).toEqual([])
    await migrated.close()

    const reopened = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
    })
    expect(reopened.stampAttemptJournal.getAll()).toEqual([])
    await reopened.close()
  })

  it('leaves a signed legacy attempt unbound when recipient resolution mismatches', async () => {
    await createLegacyRoot(root, false)
    await createSignedLegacyAttempt(root)

    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
        resolveLegacyAttemptRecipientPublicKey: async () =>
          Wallet.createRandom().signingKey.compressedPublicKey,
      })
    ).rejects.toThrow(/semantics|destination/i)
    expect(existsSync(join(root, 'wallet-manifest'))).toBe(false)
  })

  it('leaves a legacy root unbound when the supplied seed is wrong', async () => {
    await createLegacyRoot(root)

    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: SECOND_MNEMONIC },
      })
    ).rejects.toThrow(/does not belong to this seed/i)
    expect(existsSync(join(root, 'wallet-manifest'))).toBe(false)

    const legacy = new LevelSubAccountPoolStore(root)
    await legacy.Open()
    expect(legacy.getByIndex(7)?.address).toBe(
      MonadHdKeyring.fromMnemonic(FIRST_MNEMONIC).deriveSubAccount(7).address
    )
    await legacy.Close()
  })

  it.each([
    'validated',
    'marker',
    'sub-account-pool',
    'change-pool',
    'outgoing-stamp-attempts',
    'stamp-payment-journal',
    'manifest',
  ] as const)('resumes a migration interrupted after %s', async (phase) => {
    const crashRoot = join(root, phase)
    mkdirSync(crashRoot, { mode: 0o700 })
    await createLegacyRoot(crashRoot)
    await expect(
      openMonadWalletBundle({
        location: crashRoot,
        seed: { mnemonic: FIRST_MNEMONIC },
        onMigrationPhase: (reached) => {
          if (reached === phase) throw new Error(`crash:${phase}`)
        },
      })
    ).rejects.toThrow(`crash:${phase}`)

    const resumed = await openMonadWalletBundle({
      location: crashRoot,
      seed: { mnemonic: FIRST_MNEMONIC },
    })
    expect(resumed.pool.nextUnusedIndex()).toBe(8)
    await resumed.close()
  })

  it('resumes when component binding commits before its marker update', async () => {
    await createLegacyRoot(root)
    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
        onMigrationBind: (component) => {
          if (component === 'sub-account-pool') throw new Error('crash:bind')
        },
      })
    ).rejects.toThrow('crash:bind')
    const resumed = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
    })
    expect(resumed.pool.nextUnusedIndex()).toBe(8)
    await resumed.close()
  })

  it('rejects replacement of a marker-completed migration component', async () => {
    await createLegacyRoot(root)
    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
        onMigrationPhase: (phase) => {
          if (phase === 'sub-account-pool') throw new Error('crash:marker')
        },
      })
    ).rejects.toThrow('crash:marker')
    rmSync(join(root, 'sub-account-pool'), { recursive: true })
    const counterfeit = new LevelSubAccountPoolStore(root)
    await counterfeit.Open()
    await counterfeit.Close()
    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
      })
    ).rejects.toThrow(/migration provenance mismatch/i)
  })

  it('keeps exclusive ownership for the lifetime of a Node bundle', async () => {
    const first = await createNewGeneratedSeedRoot(root)
    await expect(
      openMonadWalletBundle({ location: root, createSeedIfEmpty: true })
    ).rejects.toThrow()
    first.pool.deriveNextUnfunded()
    await first.pool.flush()
    await first.close()

    const successor = await openMonadWalletBundle({
      location: root,
      createSeedIfEmpty: true,
    })
    expect(successor.pool.nextUnusedIndex()).toBe(1)
    await successor.close()
  })

  it('reaps the advisory helper after every post-ready acquisition failure', async () => {
    for (const operation of [
      'lstat',
      'open',
      'fstat',
      'random',
      'write',
      'fsync',
    ] as const) {
      await expect(
        acquireNodeWalletRootLease(root, {
          beforePostReadyOperation: (candidate) => {
            if (candidate === operation)
              throw new Error(`injected ${operation}`)
          },
        })
      ).rejects.toThrow(`injected ${operation}`)
      const successor = await acquireNodeWalletRootLease(root)
      expect(successor).toBeDefined()
      await successor?.release()
    }
  })

  it('awaits lost-lock cleanup before release resolves and a successor acquires', async () => {
    let holderPid: number | undefined
    const lease = await acquireNodeWalletRootLease(root, {
      onHolderReady: (holder) => {
        holderPid = holder.pid
      },
    })
    expect(holderPid).toBeDefined()
    process.kill(holderPid as number, 'SIGSTOP')
    writeFileSync(join(root, '.frank-wallet.lock'), 'changed-fence')
    expect(() => lease?.assertHeld()).toThrow(/fence changed/i)

    let released = false
    const release = lease?.release().then(() => {
      released = true
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(released).toBe(false)
    process.kill(holderPid as number, 'SIGCONT')
    await release
    expect(released).toBe(true)

    const successor = await acquireNodeWalletRootLease(root)
    expect(successor).toBeDefined()
    await successor?.release()
  })

  it('does not keep an idle process alive for a forgotten lease', async () => {
    const child = spawnSync(
      process.execPath,
      [
        require.resolve('jest/bin/jest'),
        'storage/monad-wallet-bundle.jest.test.ts',
        '--runInBand',
        '--testNamePattern',
        'child process forgotten lease probe',
      ],
      {
        cwd: join(__dirname, '..'),
        env: { ...process.env, FRANK_WALLET_FORGOTTEN_LEASE_ROOT: root },
        encoding: 'utf8',
        timeout: 10_000,
      }
    )
    expect(child.status).toBe(0)
    const successor = await acquireNodeWalletRootLease(root)
    expect(successor).toBeDefined()
    await successor?.release()
  })

  const childForgottenLeaseProbe = process.env.FRANK_WALLET_FORGOTTEN_LEASE_ROOT
    ? it
    : it.skip
  childForgottenLeaseProbe('child process forgotten lease probe', async () => {
    await acquireNodeWalletRootLease(
      process.env.FRANK_WALLET_FORGOTTEN_LEASE_ROOT as string
    )
  })

  it('enforces the same root lease across Node processes', async () => {
    const first = await createNewGeneratedSeedRoot(root)
    const child = spawnSync(
      process.execPath,
      [
        require.resolve('jest/bin/jest'),
        'storage/monad-wallet-bundle.jest.test.ts',
        '--runInBand',
        '--testNamePattern',
        'child process lock probe',
      ],
      {
        cwd: join(__dirname, '..'),
        env: { ...process.env, FRANK_WALLET_LOCK_PROBE_ROOT: root },
        encoding: 'utf8',
      }
    )
    expect(child.status).toBe(0)
    expect(`${child.stdout}${child.stderr}`).toContain('PASS')
    await first.close()
  })

  const childLockProbe = process.env.FRANK_WALLET_LOCK_PROBE_ROOT ? it : it.skip
  childLockProbe('child process lock probe', async () => {
    await expect(
      openMonadWalletBundle({
        location: process.env.FRANK_WALLET_LOCK_PROBE_ROOT as string,
        createSeedIfEmpty: true,
      })
    ).rejects.toThrow(/already open|crash lock/i)
  })

  it('releases the kernel root lock after SIGKILL and preserves high-water', async () => {
    const ready = join(root, '..', `wallet-lock-ready-${process.pid}`)
    rmSync(root, { recursive: true, force: true })
    const child = spawn(
      process.execPath,
      [
        require.resolve('jest/bin/jest'),
        'storage/monad-wallet-bundle.jest.test.ts',
        '--runInBand',
        '--testNamePattern',
        'child process SIGKILL lock probe',
      ],
      {
        cwd: join(__dirname, '..'),
        env: {
          ...process.env,
          FRANK_WALLET_SIGKILL_ROOT: root,
          FRANK_WALLET_SIGKILL_READY: ready,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
    let childOutput = ''
    child.stdout?.on('data', (chunk) => {
      childOutput += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      childOutput += String(chunk)
    })
    const deadline = Date.now() + 20_000
    while (!existsSync(ready) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    if (!existsSync(ready)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await new Promise<void>((resolve) =>
          child.once('exit', () => resolve())
        )
      }
      throw new Error(`SIGKILL lock probe never became ready:\n${childOutput}`)
    }
    child.kill('SIGKILL')
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))

    let successor: Awaited<ReturnType<typeof openMonadWalletBundle>> | undefined
    for (let attempt = 0; attempt < 100 && successor === undefined; attempt++) {
      try {
        successor = await openMonadWalletBundle({
          location: root,
          createSeedIfEmpty: true,
        })
      } catch (error) {
        if (!String(error).match(/already open/i)) throw error
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    expect(successor).toBeDefined()
    expect(successor?.pool.nextUnusedIndex()).toBe(1)
    await successor?.close()
    rmSync(ready, { force: true })
  }, 30_000)

  const childSigkillProbe = process.env.FRANK_WALLET_SIGKILL_ROOT ? it : it.skip
  childSigkillProbe('child process SIGKILL lock probe', async () => {
    const bundle = await openMonadWalletBundle({
      location: process.env.FRANK_WALLET_SIGKILL_ROOT as string,
      createSeedIfEmpty: true,
    })
    bundle.pool.deriveNextUnfunded()
    await bundle.pool.flush()
    writeFileSync(process.env.FRANK_WALLET_SIGKILL_READY as string, 'ready')
    await new Promise(() => undefined)
  })

  it('rejects insecure or symlinked roots before touching their targets', async () => {
    chmodSync(root, 0o777)
    await expect(
      openMonadWalletBundle({ location: root, createSeedIfEmpty: true })
    ).rejects.toThrow(/0700/)
    chmodSync(root, 0o700)

    const target = join(root, 'target')
    mkdirSync(target, { mode: 0o700 })
    symlinkSync(target, join(root, 'sub-account-pool'))
    await expect(
      openMonadWalletBundle({ location: root, createSeedIfEmpty: true })
    ).rejects.toThrow(/real directory|unexpected entry/)
    expect(existsSync(join(target, 'CURRENT'))).toBe(false)
  })

  it('rejects a dangling component symlink without creating its target', async () => {
    const missingTarget = join(tmpdir(), `missing-wallet-target-${Date.now()}`)
    symlinkSync(missingTarget, join(root, 'change-pool'))
    await expect(
      openMonadWalletBundle({ location: root, createSeedIfEmpty: true })
    ).rejects.toThrow(/real directory/i)
    expect(existsSync(missingTarget)).toBe(false)
  })

  it('fences every later mutation after the Node ownership file is replaced', async () => {
    const bundle = await createNewGeneratedSeedRoot(root)
    const lockPath = join(root, '.frank-wallet.lock')
    rmSync(lockPath)
    writeFileSync(lockPath, 'replacement', { mode: 0o600 })

    expect(() => bundle.pool.deriveNextUnfunded()).toThrow(/lock was replaced/i)
    await bundle.close()
    expect(existsSync(lockPath)).toBe(true)
  })

  it('fences mutations when root or lock permissions change during ownership', async () => {
    const initialized = await createNewGeneratedSeedRoot(root)
    await initialized.close()
    for (const target of ['root', 'lock'] as const) {
      const bundle = await openMonadWalletBundle({
        location: root,
        createSeedIfEmpty: true,
      })
      const path = target === 'root' ? root : join(root, '.frank-wallet.lock')
      chmodSync(path, target === 'root' ? 0o777 : 0o666)
      expect(() => bundle.pool.deriveNextUnfunded()).toThrow(/permissions/i)
      chmodSync(path, target === 'root' ? 0o700 : 0o600)
      await bundle.close()

      const successor = await openMonadWalletBundle({
        location: root,
        createSeedIfEmpty: true,
      })
      expect(successor.pool.nextUnusedIndex()).toBe(0)
      await successor.close()
    }
  })

  it('fences a replaced root even when its lock artifact is hard-linked into the replacement', async () => {
    const bundle = await createNewGeneratedSeedRoot(root)
    const originalRoot = `${root}-original`
    renameSync(root, originalRoot)
    mkdirSync(root, { mode: 0o700 })
    linkSync(
      join(originalRoot, '.frank-wallet.lock'),
      join(root, '.frank-wallet.lock')
    )

    expect(() => bundle.pool.deriveNextUnfunded()).toThrow(
      /identity|hard-linked|replaced/i
    )
    await expect(bundle.close()).resolves.toBeUndefined()

    rmSync(root, { recursive: true, force: true })
    renameSync(originalRoot, root)
    const successor = await openMonadWalletBundle({
      location: root,
      createSeedIfEmpty: true,
    })
    expect(successor.pool.nextUnusedIndex()).toBe(0)
    await successor.close()
  })

  it('rejects a different seed before opening or mutating component stores', async () => {
    const first = await createNewCallerSeedRoot(root)
    first.pool.ensureUnfundedSize(1)
    await first.pool.flush()
    await first.close()

    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: SECOND_MNEMONIC },
      })
    ).rejects.toThrow(/seed does not match/i)
  })

  it('rejects finalized manifest v1 roots without upgrading or mutating them', async () => {
    const current = await createNewGeneratedSeedRoot(root)
    current.pool.deriveNextUnfunded()
    await current.pool.flush()
    await current.close()
    const manifest = level(join(root, 'wallet-manifest'))
    const parsed = JSON.parse(await manifest.get('manifest'))
    const legacy = JSON.stringify({
      ...parsed,
      version: 1,
      intents: [
        'sub-account-pool-v2',
        'change-pool-v2',
        'stamp-attempt-journal-v1',
        'stamp-payment-journal-v1',
      ],
    })
    await manifest.put('manifest', legacy)
    await manifest.close()

    await expect(
      openMonadWalletBundle({ location: root, createSeedIfEmpty: true })
    ).rejects.toThrow(/manifest v1|state backup|new seed/i)
    const unchangedManifest = level(join(root, 'wallet-manifest'))
    expect(await unchangedManifest.get('manifest')).toBe(legacy)
    await unchangedManifest.close()
    const unchangedPool = new LevelSubAccountPoolStore(root)
    await unchangedPool.Open()
    expect(unchangedPool.getByIndex(0)?.status).toBe('unfunded')
    await unchangedPool.Close()
  })

  it('refuses to place a manifest over an unbound non-empty root', async () => {
    const foreign = new LevelSubAccountPoolStore(root)
    await foreign.Open()
    foreign.put({
      index: 0,
      address: '0x0000000000000000000000000000000000000001',
      status: 'unfunded',
    })
    await foreign.Close()

    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
      })
    ).rejects.toThrow(/non-empty untrusted root/i)
  })

  it('rejects a foreign seed-derived row before any network access', async () => {
    const first = await createNewCallerSeedRoot(root)
    const bindingId = first.bindingId
    await first.close()

    const store = new LevelSubAccountPoolStore(root, bindingId)
    await store.Open()
    await store.Bind()
    store.put({
      index: 7,
      address: '0x0000000000000000000000000000000000000001',
      status: 'unfunded',
    })
    await store.Close()

    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
      })
    ).rejects.toThrow(/does not belong to this seed/i)
  })

  it('rejects unexpected durable record fields before mutation', async () => {
    const first = await createNewCallerSeedRoot(root)
    const bindingId = first.bindingId
    const record = first.pool.deriveNextUnfunded()
    await first.pool.flush()
    await first.close()

    const store = new LevelSubAccountPoolStore(root, bindingId)
    await store.Open()
    store.put({ ...record, unexpected: 'field' } as never)
    await store.Close()

    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
      })
    ).rejects.toThrow(/unexpected field/i)
  })

  it('does not permit a stamp client to graft components across bundles', () => {
    const first = createInMemoryMonadWalletBundle({
      mnemonic: FIRST_MNEMONIC,
    })
    const second = createInMemoryMonadWalletBundle({
      mnemonic: SECOND_MNEMONIC,
    })

    expect(() =>
      MonadStampClient.unsafeCreateForTests({
        pool: first.pool,
        leaseManager: first.leaseManager,
        changePool: second.changePool,
        stampAttemptJournal: first.stampAttemptJournal,
        stampPaymentJournal: first.stampPaymentJournal,
        walletState: first,
        provider: {} as never,
        httpClient: {} as never,
        relayBaseUrl: 'https://relay.invalid',
      })
    ).toThrow(/one persistence bundle/i)
  })

  it('returns defensive copies from wallet stores', async () => {
    const bundle = createInMemoryMonadWalletBundle({
      mnemonic: FIRST_MNEMONIC,
    })
    bundle.pool.ensureSize(1)
    const row = bundle.pool.records()[0]
    row.address = Wallet.createRandom().address
    expect(bundle.pool.getRecord(0)?.address).not.toBe(row.address)

    await bundle.stampAttemptJournal.put({
      payloadHashHex: 'aa'.repeat(32),
      messageBytes: [1, 2, 3],
      leaseIndices: [0],
      recipientPublicKeyHex: `02${'11'.repeat(32)}`,
    })
    const attempt = bundle.stampAttemptJournal.getAll()[0]
    attempt.messageBytes[0] = 255
    attempt.leaseIndices[0] = 999
    expect(bundle.stampAttemptJournal.getAll()[0]).toMatchObject({
      messageBytes: [1, 2, 3],
      leaseIndices: [0],
    })
  })

  it('rejects a forged persistent bundle even when it copies a real bundle brand shape', async () => {
    const genuine = await createNewCallerSeedRoot(root)
    const other = createInMemoryMonadWalletBundle({
      mnemonic: SECOND_MNEMONIC,
    })
    const forged = {
      ...genuine,
      pool: other.pool,
      durability: 'persistent' as const,
    }
    expect(() =>
      createMonadStampWalletHandle({
        walletState: forged,
        provider: {} as never,
        httpClient: {} as never,
        relayBaseUrl: 'https://relay.invalid',
      })
    ).toThrow(/not produced by the persistent bundle factory/i)
    await genuine.close()
  })

  it('revokes bundle provenance on idempotent close before signing or network', async () => {
    const bundle = await createNewCallerSeedRoot(root)
    const handle = createMonadStampWalletHandle({
      walletState: bundle,
      provider: {} as never,
      httpClient: {} as never,
      relayBaseUrl: 'https://relay.invalid',
    })
    const client = new MonadStampClient(handle)
    await bundle.close()
    await expect(bundle.close()).resolves.toBeUndefined()
    expect(() =>
      createMonadStampWalletHandle({
        walletState: bundle,
        provider: {} as never,
        httpClient: {} as never,
        relayBaseUrl: 'https://relay.invalid',
      })
    ).toThrow(/not produced|closed/i)
    await expect(
      client.submitStampedMessage({
        encryptedPayload: new Uint8Array([1]),
        recipientPublicKey: new Uint8Array(33),
        stampValueWei: 1n,
      })
    ).rejects.toThrow(/closed/i)
    expect(mockedAxios).not.toHaveBeenCalled()
  })

  it('rejects loose or ephemeral production stamped-send composition', () => {
    const first = createInMemoryMonadWalletBundle({ mnemonic: FIRST_MNEMONIC })
    const second = createInMemoryMonadWalletBundle({
      mnemonic: SECOND_MNEMONIC,
    })
    expect(
      () =>
        new MonadStampClient({
          pool: first.pool,
          leaseManager: first.leaseManager,
          changePool: second.changePool,
          stampAttemptJournal: second.stampAttemptJournal,
          provider: {} as never,
          httpClient: {} as never,
          relayBaseUrl: 'https://relay.invalid',
        } as never)
    ).toThrow(/factory-produced complete wallet handle/i)
    expect(() =>
      createMonadStampWalletHandle({
        walletState: first,
        provider: {} as never,
        httpClient: {} as never,
        relayBaseUrl: 'https://relay.invalid',
      })
    ).toThrow(/durable complete wallet bundle/i)
  })

  it('requires the client-owned reconciliation permit before inventory preparation', async () => {
    const bundle = createInMemoryMonadWalletBundle({
      mnemonic: FIRST_MNEMONIC,
    })
    const preparation = {
      mainAccountSigner: {} as never,
      provider: {} as never,
      stampValueWei: 1n,
      gasReserveWei: 0n,
    }

    await expect(
      bundle.pool.prepareStampInventory(preparation)
    ).rejects.toThrow(/reconciliation is required/i)

    const client = MonadStampClient.unsafeCreateForTests({
      pool: bundle.pool,
      leaseManager: bundle.leaseManager,
      changePool: bundle.changePool,
      stampAttemptJournal: bundle.stampAttemptJournal,
      stampPaymentJournal: bundle.stampPaymentJournal,
      walletState: bundle,
      provider: {} as never,
      httpClient: {} as never,
      relayBaseUrl: 'https://relay.invalid',
    })
    await client.reconcileOrThrow()
    await expect(
      bundle.pool.prepareStampInventory({
        ...preparation,
        stampValueWei: 0n,
      })
    ).rejects.toThrow(/stampValueWei must be positive/i)
  })

  it('fails closed on an orphaned lease without retiring the recoverable row', () => {
    const bundle = createInMemoryMonadWalletBundle({
      mnemonic: FIRST_MNEMONIC,
    })
    bundle.pool.ensureSize(1)
    bundle.leaseManager.acquireLease()

    expect(() => bundle.assertNoOrphanedLeases()).toThrow(
      MonadWalletOrphanedAccountError
    )
    expect(bundle.pool.getRecord(0)?.status).toBe('in-use')
  })

  it('leaves a row-without-journal untouched when restore relay evidence is unavailable', async () => {
    const first = await createNewCallerSeedRoot(root)
    first.pool.ensureSize(1)
    first.leaseManager.acquireLease()
    await first.pool.flush()
    await first.close()

    const reopened = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
      recovery: {
        provider: {} as never,
        assertRelayAvailable: async () => {
          throw new Error('relay unavailable')
        },
        recoverSenderEvidence: async () => undefined,
      },
    })
    await expect(reopened.reconcileRestoreState()).rejects.toThrow(
      /relay unavailable/
    )
    expect(reopened.pool.getRecord(0)?.status).toBe('in-use')
    expect(reopened.stampAttemptJournal.getAll()).toEqual([])
    await reopened.close()
  })

  it('reconstructs a journal-without-row from its validated exact signed bytes', async () => {
    const first = await createNewCallerSeedRoot(root)
    first.pool.ensureSize(1)
    first.leaseManager.acquireLease()
    const payload = new TextEncoder().encode('recover exact attempt')
    const payloadHash = computeMonadStampCommitment(payload)
    const recipient = Wallet.createRandom().signingKey.compressedPublicKey
    const destination = deriveMonadStampChildPublic({
      payloadHash,
      recipientPublicKey: getBytes(recipient),
      paymentIndex: 0,
    }).address
    const sender =
      MonadHdKeyring.fromMnemonic(FIRST_MNEMONIC).deriveSubAccount(0)
    const rawTx = await new Wallet(sender.privateKey).signTransaction({
      to: destination,
      value: 5n,
      data: buildMonadStampCalldata(
        computeMonadStampPaymentCommitment(payloadHash, 0)
      ),
      nonce: 0,
      gasLimit: 50_000n,
      gasPrice: 1n,
      chainId: 1,
    })
    const payloadHashHex = hexlify(payloadHash).slice(2)
    await first.stampAttemptJournal.put({
      payloadHashHex,
      messageBytes: Array.from(
        encodeMonadStampedMessage({
          stampPayments: [{ childIndex: 0, rawTx: getBytes(rawTx) }],
          encryptedPayload: payload,
          payloadHash,
        })
      ),
      leaseIndices: [0],
      recipientPublicKeyHex: recipient,
    })
    first.pool.recordSpendTransaction(0, {
      rawTx,
      txHash: Transaction.from(rawTx).hash as string,
      valueWei: '5',
    })
    await first.pool.flush()
    await first.close()

    const rawPool = level(join(root, 'sub-account-pool'))
    await rawPool.del('0')
    await rawPool.close()
    const reopened = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
      recovery: {
        provider: {} as never,
        assertRelayAvailable: async () => undefined,
        recoverSenderEvidence: async () => undefined,
      },
    })
    await reopened.repairAttemptSpendLifecycles()
    expect(reopened.pool.getRecord(0)).toMatchObject({
      status: 'in-use',
      lifecycle: {
        spend: {
          rawTx,
          txHash: Transaction.from(rawTx).hash,
          valueWei: '5',
        },
      },
    })
    await reopened.close()
  })

  it('does not compact a terminal row while an attempt journal still references it', async () => {
    const bundle = createInMemoryMonadWalletBundle({
      mnemonic: FIRST_MNEMONIC,
    })
    bundle.pool.ensureSize(1)
    bundle.pool.recordFundingTransaction(0, {
      rawTx: '0xfund',
      txHash: '0xfundhash',
      valueWei: '100',
    })
    bundle.pool.recordSpendTransaction(0, {
      rawTx: '0xspend',
      txHash: '0xspendhash',
      valueWei: '60',
    })
    bundle.pool.recordRecoveryDisposition(0, {
      kind: 'dust',
      valueWei: '1',
      thresholdWei: '2',
    })
    bundle.pool.setStatus(0, 'in-use')
    bundle.pool.setStatus(0, 'spent')
    await bundle.stampAttemptJournal.put({
      payloadHashHex: 'ab'.repeat(32),
      messageBytes: [1],
      leaseIndices: [0],
      recipientPublicKeyHex: `02${'11'.repeat(32)}`,
    })

    await expect(bundle.compactTerminalAccounts(1)).resolves.toBe(0)
    expect(bundle.pool.getRecord(0)).toBeDefined()

    await bundle.stampAttemptJournal.delete('ab'.repeat(32))
    await expect(bundle.compactTerminalAccounts(1)).resolves.toBe(1)
    expect(bundle.pool.getRecord(0)).toBeUndefined()
    expect(bundle.pool.terminalCheckpoints()[0]).toMatchObject({
      version: 1,
      denominationWei: '60',
    })
  })
})
