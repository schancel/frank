import {
  InMemoryStampPaymentJournal,
  LevelStampPaymentJournal,
  StampPaymentRecoveryRecord,
} from './stamp-payment-journal'

const DISCOVERED: StampPaymentRecoveryRecord = {
  payloadHashHex: 'ab'.repeat(32),
  childIndex: 1,
  txHash: `0x${'11'.repeat(32)}`,
  address: `0x${'22'.repeat(20)}`,
  valueWei: '123',
  status: 'discovered',
}

describe('stamp payment recovery journal', () => {
  it('updates one public record without ever requiring a private key', () => {
    const journal = new InMemoryStampPaymentJournal()
    journal.put(DISCOVERED)
    journal.put({
      ...DISCOVERED,
      status: 'swept',
      sweepTxHash: `0x${'33'.repeat(32)}`,
    })

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
      first.put(DISCOVERED)
      await first.Close()

      const reopened = new LevelStampPaymentJournal(dir)
      await reopened.Open()
      expect(reopened.get(DISCOVERED.payloadHashHex, 1)).toEqual(DISCOVERED)
      await reopened.Close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
