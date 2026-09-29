import {
  InMemoryStampPaymentJournal,
  LevelStampPaymentJournal,
  StampPaymentRecoveryRecord,
} from './stamp-payment-journal'
import { Transaction, Wallet } from 'ethers'

const DISCOVERED: StampPaymentRecoveryRecord = {
  payloadHashHex: 'ab'.repeat(32),
  childIndex: 1,
  txHash: `0x${'11'.repeat(32)}`,
  rawTx: '0x01',
  recipientPublicKeyHex: `0x02${'33'.repeat(32)}`,
  envelopeRecipientAddress: `0x${'44'.repeat(20)}`,
  address: `0x${'22'.repeat(20)}`,
  valueWei: '123',
  status: 'discovered',
}

const SWEEP_DESTINATION = `0x${'55'.repeat(20)}`

async function signedSweep(nonce: number): Promise<{
  txHash: string
  rawTx: string
}> {
  const rawTx = await new Wallet(`0x${'99'.repeat(32)}`).signTransaction({
    to: SWEEP_DESTINATION,
    value: 100n,
    nonce,
    gasLimit: 21_000n,
    gasPrice: 1n,
    chainId: 1,
  })
  return { rawTx, txHash: Transaction.from(rawTx).hash as string }
}

describe('stamp payment recovery journal', () => {
  it('rejects conflicting authority for the same payload child identity', async () => {
    const journal = new InMemoryStampPaymentJournal()
    await journal.put(DISCOVERED)
    await expect(journal.put({ ...DISCOVERED, rawTx: '0x02' })).rejects.toThrow(
      /conflicting/i
    )
    expect(journal.getAll()).toEqual([DISCOVERED])
  })
  it('preflights a complete discovered set before committing any child', async () => {
    const journal = new InMemoryStampPaymentJournal()
    await journal.put(DISCOVERED)
    const newChild: StampPaymentRecoveryRecord = {
      ...DISCOVERED,
      childIndex: 2,
      txHash: `0x${'66'.repeat(32)}`,
      address: `0x${'77'.repeat(20)}`,
    }
    await expect(
      journal.putDiscovered([newChild, { ...DISCOVERED, rawTx: '0xconflict' }])
    ).rejects.toThrow(/conflicting/i)
    expect(journal.get(DISCOVERED.payloadHashHex, 2)).toBeUndefined()
    expect(journal.getAll()).toEqual([DISCOVERED])
  })
  it('forbids replacing or rewinding a durable signed sweep intent', async () => {
    const journal = new InMemoryStampPaymentJournal()
    const pending: StampPaymentRecoveryRecord = {
      ...DISCOVERED,
      status: 'sweep-pending',
      sweepTxHash: `0x${'33'.repeat(32)}`,
      sweepRawTx: '0x1234',
      sweepValueWei: '100',
      sweepDestinationAddress: `0x${'55'.repeat(20)}`,
    }
    await journal.put(DISCOVERED)
    await journal.put(pending)
    await expect(
      journal.put({ ...pending, sweepRawTx: '0xabcd' })
    ).rejects.toThrow(/immutable/i)
    await expect(journal.put(DISCOVERED)).rejects.toThrow(/backward/i)
    await journal.put({ ...pending, status: 'swept' })
    await expect(journal.put(pending)).rejects.toThrow(/backward/i)
  })
  it('retains an exact failed intent before permitting a fresh pending nonce', async () => {
    const journal = new InMemoryStampPaymentJournal()
    const firstSweep = await signedSweep(0)
    const secondSweep = await signedSweep(1)
    const pending: StampPaymentRecoveryRecord = {
      ...DISCOVERED,
      status: 'sweep-pending',
      sweepTxHash: firstSweep.txHash,
      sweepRawTx: firstSweep.rawTx,
      sweepValueWei: '100',
      sweepDestinationAddress: SWEEP_DESTINATION,
    }
    await journal.put(pending)
    const failed: StampPaymentRecoveryRecord = {
      ...pending,
      status: 'sweep-failed',
      failedSweeps: [
        {
          txHash: pending.sweepTxHash!,
          rawTx: pending.sweepRawTx!,
          valueWei: pending.sweepValueWei!,
          destinationAddress: pending.sweepDestinationAddress!,
        },
      ],
    }
    await journal.put(failed)
    await expect(
      journal.put({ ...failed, status: 'sweep-pending' })
    ).rejects.toThrow(/cannot be replayed/i)
    await journal.put({
      ...failed,
      status: 'sweep-pending',
      sweepTxHash: secondSweep.txHash,
      sweepRawTx: secondSweep.rawTx,
    })
    expect(journal.getAll()[0].failedSweeps).toEqual(failed.failedSweeps)
  })

  it('appends exactly the active pending intent when recording a mined failure', async () => {
    const journal = new InMemoryStampPaymentJournal()
    const firstSweep = await signedSweep(0)
    const unrelatedSweep = await signedSweep(1)
    const pending: StampPaymentRecoveryRecord = {
      ...DISCOVERED,
      status: 'sweep-pending',
      sweepTxHash: firstSweep.txHash,
      sweepRawTx: firstSweep.rawTx,
      sweepValueWei: '100',
      sweepDestinationAddress: SWEEP_DESTINATION,
    }
    await journal.put(pending)
    await expect(
      journal.put({
        ...pending,
        status: 'sweep-failed',
        failedSweeps: [
          {
            txHash: unrelatedSweep.txHash,
            rawTx: unrelatedSweep.rawTx,
            valueWei: '100',
            destinationAddress: SWEEP_DESTINATION,
          },
          {
            txHash: firstSweep.txHash,
            rawTx: firstSweep.rawTx,
            valueWei: '100',
            destinationAddress: SWEEP_DESTINATION,
          },
        ],
      })
    ).rejects.toThrow(/exactly one/i)
    expect(journal.getAll()).toEqual([pending])
  })
  it('updates one public record without ever requiring a private key', async () => {
    const journal = new InMemoryStampPaymentJournal()
    await journal.put(DISCOVERED)
    const pending: StampPaymentRecoveryRecord = {
      ...DISCOVERED,
      status: 'sweep-pending',
      sweepTxHash: `0x${'33'.repeat(32)}`,
      sweepRawTx: '0x1234',
      sweepValueWei: '100',
      sweepDestinationAddress: `0x${'55'.repeat(20)}`,
    }
    await journal.put(pending)
    await journal.put({ ...pending, status: 'swept' })

    expect(journal.get(DISCOVERED.payloadHashHex, 1)).toMatchObject({
      status: 'swept',
      valueWei: '123',
    })
    expect(journal.getAll()).toHaveLength(1)
    expect(journal.getAll()[0]).not.toHaveProperty('privateKey')
  })

  it('survives a LevelDB close and reopen', async () => {
    const os = await import('os')
    const path = await import('path')
    const fs = await import('fs')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-payment-journal-'))
    try {
      const first = new LevelStampPaymentJournal(dir)
      await first.Open()
      await first.put(DISCOVERED)
      await first.Close()

      const reopened = new LevelStampPaymentJournal(dir)
      await reopened.Open()
      expect(reopened.get(DISCOVERED.payloadHashHex, 1)).toEqual(DISCOVERED)
      await reopened.Close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists an exact pending sweep intent across a LevelDB restart', async () => {
    const os = await import('os')
    const path = await import('path')
    const fs = await import('fs')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-payment-journal-'))
    const pending: StampPaymentRecoveryRecord = {
      ...DISCOVERED,
      status: 'sweep-pending',
      sweepTxHash: `0x${'33'.repeat(32)}`,
      sweepRawTx: `0x${'44'.repeat(96)}`,
      sweepValueWei: '100',
      sweepDestinationAddress: `0x${'55'.repeat(20)}`,
    }
    try {
      const first = new LevelStampPaymentJournal(dir)
      await first.Open()
      await first.put(pending)
      await first.Close()

      const reopened = new LevelStampPaymentJournal(dir)
      await reopened.Open()
      expect(reopened.get(DISCOVERED.payloadHashHex, 1)).toEqual(pending)
      expect(reopened.getAll()[0]).not.toHaveProperty('privateKey')
      await reopened.Close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists a mined failed intent before permitting a fresh intent after restart', async () => {
    const os = await import('os')
    const path = await import('path')
    const fs = await import('fs')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-payment-journal-'))
    const firstSweep = await signedSweep(0)
    const secondSweep = await signedSweep(1)
    const pending: StampPaymentRecoveryRecord = {
      ...DISCOVERED,
      status: 'sweep-pending',
      sweepTxHash: firstSweep.txHash,
      sweepRawTx: firstSweep.rawTx,
      sweepValueWei: '100',
      sweepDestinationAddress: SWEEP_DESTINATION,
    }
    const failed: StampPaymentRecoveryRecord = {
      ...pending,
      status: 'sweep-failed',
      failedSweeps: [
        {
          txHash: pending.sweepTxHash!,
          rawTx: pending.sweepRawTx!,
          valueWei: pending.sweepValueWei!,
          destinationAddress: pending.sweepDestinationAddress!,
        },
      ],
    }
    try {
      const first = new LevelStampPaymentJournal(dir)
      await first.Open()
      await first.put(pending)
      await first.put(failed)
      await first.Close()

      const reopened = new LevelStampPaymentJournal(dir)
      await reopened.Open()
      expect(reopened.get(DISCOVERED.payloadHashHex, 1)).toEqual(failed)
      await reopened.put({
        ...failed,
        status: 'sweep-pending',
        sweepTxHash: secondSweep.txHash,
        sweepRawTx: secondSweep.rawTx,
      })
      expect(reopened.getAll()[0].failedSweeps).toEqual(failed.failedSweeps)
      await reopened.Close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('commits a discovered child set atomically in LevelDB', async () => {
    const os = await import('os')
    const path = await import('path')
    const fs = await import('fs')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-payment-journal-'))
    const newChild: StampPaymentRecoveryRecord = {
      ...DISCOVERED,
      childIndex: 2,
      txHash: `0x${'66'.repeat(32)}`,
      address: `0x${'77'.repeat(20)}`,
    }
    try {
      const first = new LevelStampPaymentJournal(dir)
      await first.Open()
      await first.put(DISCOVERED)
      await expect(
        first.putDiscovered([newChild, { ...DISCOVERED, rawTx: '0xconflict' }])
      ).rejects.toThrow(/conflicting/i)
      await first.Close()

      const reopened = new LevelStampPaymentJournal(dir)
      await reopened.Open()
      expect(reopened.get(DISCOVERED.payloadHashHex, 2)).toBeUndefined()
      expect(reopened.getAll()).toEqual([DISCOVERED])
      await reopened.Close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects new work while closing and drains an admitted payment operation before Level close', async () => {
    const os = await import('os')
    const path = await import('path')
    const fs = await import('fs')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-payment-journal-'))
    let resume!: () => void
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve
    })
    const pause = new Promise<void>((resolve) => {
      resume = resolve
    })
    try {
      const first = new LevelStampPaymentJournal(dir)
      await first.Open()
      const active = first.withPaymentLock(
        DISCOVERED.payloadHashHex,
        DISCOVERED.childIndex,
        async (locked) => {
          entered()
          await pause
          await locked.put(DISCOVERED)
        }
      )
      await enteredPromise
      let closed = false
      const closing = first.Close().then(() => {
        closed = true
      })
      await expect(first.put(DISCOVERED)).rejects.toThrow(/not open/i)
      expect(() =>
        first.withPaymentLock(
          DISCOVERED.payloadHashHex,
          DISCOVERED.childIndex,
          async () => undefined
        )
      ).toThrow(/not open/i)
      await Promise.resolve()
      expect(closed).toBe(false)

      resume()
      await active
      await closing

      const successor = new LevelStampPaymentJournal(dir)
      await successor.Open()
      expect(
        successor.get(DISCOVERED.payloadHashHex, DISCOVERED.childIndex)
      ).toEqual(DISCOVERED)
      await successor.Close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
