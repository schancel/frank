/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LevelStampAttemptJournal } from './stamp-attempt-journal'
import { LevelStampPaymentJournal } from './stamp-payment-journal'
import * as durability from './level-durability'

jest.mock('./level-durability', () => {
  const actual = jest.requireActual('./level-durability')
  return { ...actual, openDurableLevel: jest.fn(actual.openDurableLevel) }
})

const attempt = {
  payloadHashHex: 'ab'.repeat(32),
  messageBytes: [0, 255, 17],
  leaseIndices: [4, 7],
}
const payment = {
  payloadHashHex: 'ab'.repeat(32),
  childIndex: 1,
  txHash: '0x' + '11'.repeat(32),
  address: '0x' + '22'.repeat(20),
  valueWei: '123',
  status: 'sweep-pending' as const,
  sweepRawTx: '0x' + '44'.repeat(96),
  sweepTxHash: '0x' + '33'.repeat(32),
  sweepValueWei: '100',
  sweepDestinationAddress: '0x' + '55'.repeat(20),
}
const cases = [
  {
    name: 'attempt',
    component: 'outgoing-stamp-attempts',
    create: (dir: string) => new LevelStampAttemptJournal(dir),
    record: attempt,
  },
  {
    name: 'payment',
    component: 'stamp-payment-journal',
    create: (dir: string) => new LevelStampPaymentJournal(dir),
    record: payment,
  },
]

for (const fixture of cases)
  describe(`${fixture.name} journal durability`, () => {
    let dir: string
    let journal: any
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'legacy-durable-'))
      journal = fixture.create(dir)
      jest.mocked(durability.openDurableLevel).mockClear()
    })
    afterEach(async () => {
      await journal.Close()
      jest.restoreAllMocks()
      rmSync(dir, { recursive: true, force: true })
    })

    it('uses the shared open barrier and synchronous native writes before publishing records', async () => {
      await journal.Open()
      const put = jest.spyOn(journal.db, 'put')
      await journal.put(fixture.record)
      expect(put.mock.calls[0][2]).toEqual({ sync: true })
      expect(durability.openDurableLevel).toHaveBeenCalledWith(
        journal.db,
        dir,
        fixture.component,
      )
      expect(journal.getAll()).toEqual([fixture.record])
      await journal.Close()
      await journal.Open()
      expect(journal.getAll()).toEqual([fixture.record])
      if (fixture.name === 'attempt') {
        const del = jest.spyOn(journal.db, 'del')
        await journal.delete(attempt.payloadHashHex)
        expect(del.mock.calls[0][1]).toEqual({ sync: true })
        await journal.Close()
        await journal.Open()
        expect(journal.getAll()).toEqual([])
      }
    })

    it('publishes cache state only after the durable write acknowledgement', async () => {
      await journal.Open()
      const db = journal.db
      const original = db.put.bind(db)
      let release!: () => void
      let committed!: () => void
      const acknowledgement = new Promise<void>(resolve => {
        release = resolve
      })
      const onCommitted = new Promise<void>(resolve => {
        committed = resolve
      })
      jest.spyOn(db, 'put').mockImplementationOnce(async (...args: any[]) => {
        await original(...args)
        committed()
        await acknowledgement
      })
      const pending = journal.put(fixture.record)
      try {
        await onCommitted
        expect(journal.getAll()).toEqual([])
      } finally {
        release()
        await pending
      }
      expect(journal.getAll()).toEqual([fixture.record])
    })

    it.each([false, true])(
      'holds an uncertain put until reopen (committed=%s)',
      async committed => {
        await journal.Open()
        const db = journal.db
        const original = db.put.bind(db)
        jest.spyOn(db, 'put').mockImplementationOnce(async (...args: any[]) => {
          if (committed) await original(...args)
          throw new Error('uncertain put')
        })
        await expect(journal.put(fixture.record)).rejects.toThrow(
          'uncertain put',
        )
        expect(() => journal.getAll()).toThrow(/reopen/i)
        if (fixture.name === 'payment')
          expect(() => journal.get(payment.payloadHashHex, 1)).toThrow(
            /reopen/i,
          )
        await expect(journal.put(fixture.record)).rejects.toThrow(/reopen/i)
        await journal.Close()
        await journal.Open()
        expect(journal.getAll()).toEqual(committed ? [fixture.record] : [])
      },
    )

    it('does not expose a successful open when its durability barrier fails', async () => {
      jest
        .mocked(durability.openDurableLevel)
        .mockRejectedValueOnce(new Error('strict durability unavailable'))
      await expect(journal.Open()).rejects.toThrow(
        'strict durability unavailable',
      )
      expect(() => journal.getAll()).toThrow(/reopen/i)
      await expect(journal.put(fixture.record)).rejects.toThrow()
      // Failed opening releases its Level lock and permits a later explicit retry.
      await journal.Open()
      expect(journal.getAll()).toEqual([])
    })
  })

it.each([false, true])(
  'attempt deletion holds an uncertain result until reopen (committed=%s)',
  async committed => {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-delete-'))
    const journal = new LevelStampAttemptJournal(dir)
    try {
      await journal.Open()
      await journal.put(attempt)
      const db = (journal as any).db
      const original = db.del.bind(db)
      jest.spyOn(db, 'del').mockImplementationOnce(async (...args: any[]) => {
        if (committed) await original(...args)
        throw new Error('uncertain delete')
      })
      await expect(journal.delete(attempt.payloadHashHex)).rejects.toThrow(
        'uncertain delete',
      )
      expect(() => journal.getAll()).toThrow(/reopen/i)
      await journal.Close()
      await journal.Open()
      expect(journal.getAll()).toEqual(committed ? [] : [attempt])
    } finally {
      await journal.Close()
      jest.restoreAllMocks()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
