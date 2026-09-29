import {
  InMemoryStampPaymentJournal,
  LevelStampPaymentJournal,
  StampPaymentRecoveryRecord,
} from './stamp-payment-journal'

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
      journal.putDiscovered([
        newChild,
        { ...DISCOVERED, rawTx: '0xconflict' },
      ])
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
    const pending: StampPaymentRecoveryRecord = {
      ...DISCOVERED,
      status: 'sweep-pending',
      sweepTxHash: `0x${'33'.repeat(32)}`,
      sweepRawTx: '0x1234',
      sweepValueWei: '100',
      sweepDestinationAddress: `0x${'55'.repeat(20)}`,
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
    await expect(journal.put({ ...failed, status: 'sweep-pending' })).rejects.toThrow(
      /nonce cannot be replayed/i
    )
    await journal.put({
      ...failed,
      status: 'sweep-pending',
      sweepTxHash: `0x${'44'.repeat(32)}`,
      sweepRawTx: '0x5678',
    })
    expect(journal.getAll()[0].failedSweeps).toEqual(failed.failedSweeps)
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
    const pending: StampPaymentRecoveryRecord = {
      ...DISCOVERED,
      status: 'sweep-pending',
      sweepTxHash: `0x${'33'.repeat(32)}`,
      sweepRawTx: `0x${'44'.repeat(96)}`,
      sweepValueWei: '100',
      sweepDestinationAddress: `0x${'55'.repeat(20)}`,
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
        sweepTxHash: `0x${'66'.repeat(32)}`,
        sweepRawTx: `0x${'77'.repeat(96)}`,
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
        first.putDiscovered([
          newChild,
          { ...DISCOVERED, rawTx: '0xconflict' },
        ])
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
})
