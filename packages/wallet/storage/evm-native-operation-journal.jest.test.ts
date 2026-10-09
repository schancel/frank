import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import level from 'level'
import { Transaction, Wallet } from 'ethers'
import * as durability from './level-durability'
import {
  EvmNativeOperationJournal,
  type EvmNativePlan,
  type EvmNativeBinding,
} from './evm-native-operation-journal'

const wallet = new Wallet('0x' + '41'.repeat(32))
const address = wallet.address.toLowerCase()
const binding: EvmNativeBinding = {
  chainIdentifier: 'monad-testnet',
  nativeChainId: '10143',
  publicTuple: 'public economic wallet descriptor',
}
const hash = '0x' + '12'.repeat(32)
const account = {
  blockHash: hash,
  blockNumber: 1,
  nonce: 1,
  balanceWei: '10000',
}
function plan(nonce = 0, chainId = 10143n): EvmNativePlan {
  return {
    kind: 'native',
    recipient: address,
    intendedValueWei: '1000',
    members: [
      {
        source: { kind: 'main', address },
        unsignedTransaction: Transaction.from({
          type: 2,
          chainId,
          nonce,
          to: address,
          value: 1000n,
          gasLimit: 21000n,
          maxFeePerGas: 1n,
          maxPriorityFeePerGas: 1n,
        }).unsignedSerialized,
        dependencies: [],
      },
    ],
  }
}
describe('durable EVM native journal', () => {
  let root: string
  let journal: EvmNativeOperationJournal
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'frank-native-journal-'))
    journal = new EvmNativeOperationJournal({ location: root, binding })
    await journal.Open()
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await journal.Close()
    await rm(root, { recursive: true, force: true })
  })
  async function reopen() {
    await journal.Close()
    journal = new EvmNativeOperationJournal({ location: root, binding })
    await journal.Open()
  }
  async function signed() {
    const row = await journal.prepare(plan())
    return journal.checkpointSigned(
      row.operationId,
      0,
      await wallet.signTransaction(
        Transaction.from(row.members[0]!.unsignedTransaction),
      ),
    )
  }
  it('persists signed bytes and claims before exposure; contains no private keys', async () => {
    const row = await signed()
    await journal.markExposed(row.operationId, 0)
    await reopen()
    expect(journal.get(row.operationId).members[0]!.signed).toEqual(
      row.members[0]!.signed,
    )
    expect(journal.canSelect(address, 0)).toBe(false)
    await journal.Close()
    const db = level(join(root, 'evm-native-operations-v1'))
    try {
      for await (const [, value] of db.iterator())
        expect(String(value)).not.toContain(wallet.privateKey.slice(2))
    } finally {
      await db.close()
    }
  })
  it.each(['exposed', 'middle', 'cancelled', 'zero-sequence'])(
    'refuses incomplete retained history (%s) without changing durable bytes',
    async problem => {
      const rows = []
      for (let i = 0; i < (problem === 'middle' ? 3 : 1); i++) {
        const row = await journal.prepare(plan(i))
        rows.push(row)
        if (problem === 'exposed') {
          await journal.checkpointSigned(
            row.operationId,
            0,
            await wallet.signTransaction(
              Transaction.from(row.members[0]!.unsignedTransaction),
            ),
          )
          await journal.markExposed(row.operationId, 0)
        } else await journal.cancelUnsigned(row.operationId)
      }
      await journal.Close()
      const db = level(join(root, 'evm-native-operations-v1'))
      const missing = rows[problem === 'middle' ? 1 : 0]!
      await db.del(`operation:${missing.operationId}`)
      if (problem === 'zero-sequence') {
        const operationId = 'evm-native-v1:0000000000000000'
        await db.put(
          `operation:${operationId}`,
          JSON.stringify({ ...missing, operationId }),
        )
      }
      const before = []
      for await (const entry of db.iterator()) before.push(entry.map(String))
      await db.close()
      await expect(journal.Open()).rejects.toThrow()
      expect(() => journal.canSelect(address, 0)).toThrow()
      const check = level(join(root, 'evm-native-operations-v1'))
      try {
        const after = []
        for await (const entry of check.iterator())
          after.push(entry.map(String))
        expect(after).toEqual(before)
      } finally {
        await check.close()
      }
    },
  )
  it('reserves maximum evidence growth before signing and refuses new admission at capacity', async () => {
    const row = await signed()
    await journal.Close()
    journal = new EvmNativeOperationJournal({
      location: root,
      binding,
      maxBytes: row.reservedBytes,
      maxRecords: 1,
    })
    await journal.Open()
    await expect(journal.prepare(plan(1))).rejects.toMatchObject({
      code: 'capacity',
    })
    const capture = journal.beginCapture(row.operationId, 0)
    await journal.recordObservation(
      capture,
      {
        state: 'included-success',
        transactionHash: row.members[0]!.signed!.transactionHash,
        blockHash: hash,
        blockNumber: Number.MAX_SAFE_INTEGER,
        transactionIndex: Number.MAX_SAFE_INTEGER,
        feeWei: ((1n << 256n) - 1n).toString(),
      },
      {
        ...account,
        blockNumber: Number.MAX_SAFE_INTEGER,
        nonce: Number.MAX_SAFE_INTEGER,
        balanceWei: ((1n << 256n) - 1n).toString(),
      },
    )
    expect(journal.get(row.operationId).reservedBytes).toBe(row.reservedBytes)
    await journal.markExposed(row.operationId, 0)
    expect(journal.get(row.operationId).members[0]!.exposed).toBe(true)
  })
  it('faults after an ambiguous write and reopens the actual committed checkpoint', async () => {
    const row = await journal.prepare(plan())
    const original = durability.durablePut
    jest
      .spyOn(durability, 'durablePut')
      .mockImplementationOnce(async (...args) => {
        await original(...args)
        throw new Error('commit response lost')
      })
    const raw = await wallet.signTransaction(
      Transaction.from(row.members[0]!.unsignedTransaction),
    )
    await expect(
      journal.checkpointSigned(row.operationId, 0, raw),
    ).rejects.toThrow('commit response lost')
    expect(() => journal.list()).toThrow('uncertain')
    await reopen()
    expect(
      journal.get(row.operationId).members[0]!.signed!.rawTransaction,
    ).toBe(raw)
    expect(journal.get(row.operationId).members[0]!.exposed).toBe(false)
  })
  it('does not overwrite newer observations or accept captures from a closed owner', async () => {
    const row = await signed()
    const old = journal.beginCapture(row.operationId, 0)
    const next = journal.beginCapture(row.operationId, 0)
    await journal.recordObservation(next, { state: 'pending' }, account)
    expect(
      await journal.recordObservation(old, { state: 'missing' }, account),
    ).toBe(false)
    expect(journal.get(row.operationId).members[0]!.observation.state).toBe(
      'pending',
    )
    const former = journal
    await reopen()
    await expect(
      former.recordObservation(next, { state: 'missing' }, account),
    ).rejects.toMatchObject({ code: 'closed' })
    expect(
      await journal.recordObservation(next, { state: 'missing' }, account),
    ).toBe(false)
  })
  it('releases only unsigned claims while retaining public derivation provenance and capacity', async () => {
    const input = plan()
    input.members[0]!.source = {
      kind: 'identity-stealth-v1',
      address,
      identityPublicKey: wallet.signingKey.compressedPublicKey,
      ephemeralPublicKey: wallet.signingKey.compressedPublicKey,
    }
    const row = await journal.prepare(input)
    await journal.cancelUnsigned(row.operationId)
    await reopen()
    expect(journal.canSelect(address, 0)).toBe(true)
    expect(journal.sourceReferences()).toEqual([input.members[0]!.source])
    expect(journal.list()[0]!.reservedBytes).toBe(row.reservedBytes)
    const next = await signed()
    await expect(
      journal.cancelUnsigned(next.operationId),
    ).rejects.toMatchObject({ code: 'conflict' })
  })
  it.each(['binding', 'version', 'charge'] as const)(
    'preserves incompatible %s bytes instead of resetting',
    async problem => {
      const row = await signed()
      await journal.Close()
      const db = level(join(root, 'evm-native-operations-v1'))
      const key = `operation:${row.operationId}`
      const edited = {
        ...row,
        ...(problem === 'binding'
          ? { binding: { ...binding, publicTuple: 'other owner' } }
          : problem === 'version'
          ? { version: 99 }
          : { reservedBytes: 1 }),
      }
      const bytes = JSON.stringify(edited)
      await db.put(key, bytes)
      await db.close()
      await expect(journal.Open()).rejects.toThrow()
      const check = level(join(root, 'evm-native-operations-v1'))
      try {
        expect(String(await check.get(key))).toBe(bytes)
      } finally {
        await check.close()
      }
    },
  )
  it('uses canonical chain binding and exact native chain signatures for peer EVM networks', async () => {
    const wrong = plan(0, 11155111n)
    await expect(journal.prepare(wrong)).rejects.toThrow()
    const sepolia = new EvmNativeOperationJournal({
      location: join(root, 'peer'),
      binding: {
        ...binding,
        chainIdentifier: 'ethereum-sepolia',
        nativeChainId: '11155111',
      },
    })
    await import('fs/promises').then(fs => fs.mkdir(join(root, 'peer')))
    await sepolia.Open()
    try {
      expect((await sepolia.prepare(wrong)).binding.chainIdentifier).toBe(
        'ethereum-sepolia',
      )
    } finally {
      await sepolia.Close()
    }
  })
  it('rejects mismatched signed sender or economics before exposure', async () => {
    const row = await journal.prepare(plan())
    const tx = Transaction.from(row.members[0]!.unsignedTransaction)
    tx.value++
    await expect(
      journal.checkpointSigned(
        row.operationId,
        0,
        await wallet.signTransaction(tx),
      ),
    ).rejects.toThrow()
    const stranger = new Wallet('0x' + '42'.repeat(32))
    await expect(
      journal.checkpointSigned(
        row.operationId,
        0,
        await stranger.signTransaction(
          Transaction.from(row.members[0]!.unsignedTransaction),
        ),
      ),
    ).rejects.toThrow()
    expect(journal.get(row.operationId).members[0]!.signed).toBeNull()
  })
  it('bounds members and unsigned serialization before exposing any bytes', async () => {
    const tooMany = plan()
    tooMany.members = Array.from(
      { length: 65 },
      (_, index) => plan(index).members[0]!,
    )
    await expect(journal.prepare(tooMany)).rejects.toThrow()
    const oversized = plan()
    const tx = Transaction.from(oversized.members[0]!.unsignedTransaction)
    tx.data = '0x' + 'ff'.repeat(65536)
    oversized.members[0]!.unsignedTransaction = tx.unsignedSerialized
    await expect(journal.prepare(oversized)).rejects.toThrow()
    expect(journal.list()).toEqual([])
  })
})

test('maximum supported member count and near-limit signed envelope fit their original reservation', async () => {
  const journal = new EvmNativeOperationJournal({
    binding,
    testOnlyEphemeral: true,
  })
  await journal.Open()
  try {
    const input = plan()
    input.kind = 'legacy'
    const leader = new Wallet('0x' + (64).toString(16).padStart(64, '0'))
      .address
    input.members = Array.from({ length: 64 }, (_, i) => {
      const key = new Wallet('0x' + (i + 1).toString(16).padStart(64, '0'))
      const tx = Transaction.from(plan().members[0]!.unsignedTransaction)
      tx.to = i === 63 ? address : leader
      return {
        ...plan().members[0]!,
        unsignedTransaction: tx.unsignedSerialized,
        dependencies:
          i === 63 ? Array.from({ length: 63 }, (_, index) => index) : [],
        source: {
          kind: 'spend' as const,
          index: i,
          address: key.address.toLowerCase(),
        },
      }
    })
    expect((await journal.prepare(input)).members).toHaveLength(64)
    const large = plan()
    const tx = Transaction.from(large.members[0]!.unsignedTransaction)
    tx.data = '0x' + 'ff'.repeat(65400)
    large.members[0]!.unsignedTransaction = tx.unsignedSerialized
    const row = await journal.prepare(large)
    const raw = await wallet.signTransaction(tx)
    const signed = await journal.checkpointSigned(row.operationId, 0, raw)
    expect(Buffer.byteLength(JSON.stringify(signed))).toBeLessThan(
      row.reservedBytes,
    )
    expect(signed.reservedBytes).toBe(row.reservedBytes)
  } finally {
    await journal.Close()
  }
})
